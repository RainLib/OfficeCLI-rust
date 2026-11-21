#!/bin/bash
set -e

REPO="RainLib/Foldly"
BINARY_NAME="officecli"
GITHUB_RAW_BASE="https://raw.githubusercontent.com/$REPO/main"

# Optional: pin a release tag, e.g. OFFICECLI_VERSION=v0.1.2
# Default "latest" uses the newest published (non-draft) GitHub Release.
OFFICECLI_VERSION="${OFFICECLI_VERSION:-latest}"
if [ "$OFFICECLI_VERSION" = "latest" ]; then
    RELEASE_BASE="https://github.com/$REPO/releases/latest/download"
else
    RELEASE_BASE="https://github.com/$REPO/releases/download/$OFFICECLI_VERSION"
fi

# Detect platform
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$OS" in
    darwin)
        case "$ARCH" in
            arm64) ASSET="officecli-mac-arm64" ;;
            x86_64) ASSET="officecli-mac-x64" ;;
            *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
        esac
        ;;
    linux)
        LIBC="gnu"
        if command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; then
            LIBC="musl"
        elif [ -f /etc/alpine-release ]; then
            LIBC="musl"
        fi
        case "$ARCH" in
            x86_64)
                if [ "$LIBC" = "musl" ]; then
                    ASSET="officecli-linux-alpine-x64"
                else
                    ASSET="officecli-linux-x64"
                fi
                ;;
            aarch64|arm64)
                if [ "$LIBC" = "musl" ]; then
                    echo "Linux ARM64 musl (Alpine) binary is not published yet."
                    echo "Use a gnu build or build from source: cargo build --release"
                    exit 1
                else
                    ASSET="officecli-linux-arm64"
                fi
                ;;
            *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
        esac
        ;;
    *)
        echo "Unsupported OS: $OS"
        echo "For Windows, run: irm https://raw.githubusercontent.com/$REPO/main/install.ps1 | iex"
        echo "Or download from: https://github.com/$REPO/releases"
        exit 1
        ;;
esac

SOURCE=""

# Step 1: Download from GitHub Release
echo "Downloading OfficeCLI ($ASSET) from $REPO..."
if curl -fsSL --max-time 300 "$RELEASE_BASE/$ASSET" -o "/tmp/$BINARY_NAME"; then
    CHECKSUM_OK=false
    if curl -fsSL --max-time 300 "$RELEASE_BASE/SHA256SUMS" -o "/tmp/officecli-SHA256SUMS" 2>/dev/null; then
        EXPECTED=$(grep "$ASSET" "/tmp/officecli-SHA256SUMS" | awk '{print $1}')
        if [ -n "$EXPECTED" ]; then
            if command -v sha256sum >/dev/null 2>&1; then
                ACTUAL=$(sha256sum "/tmp/$BINARY_NAME" | awk '{print $1}')
            else
                ACTUAL=$(shasum -a 256 "/tmp/$BINARY_NAME" | awk '{print $1}')
            fi
            if [ "$EXPECTED" = "$ACTUAL" ]; then
                CHECKSUM_OK=true
                echo "Checksum verified."
            else
                echo "Checksum mismatch! Expected: $EXPECTED, Got: $ACTUAL"
                rm -f "/tmp/$BINARY_NAME" "/tmp/officecli-SHA256SUMS"
                exit 1
            fi
        fi
        rm -f "/tmp/officecli-SHA256SUMS"
    fi
    if [ "$CHECKSUM_OK" = false ]; then
        echo "Checksum file not available, skipping verification."
    fi
    chmod +x "/tmp/$BINARY_NAME"
    SOURCE="/tmp/$BINARY_NAME"
else
    echo "Download failed."
    echo "Tip: releases/latest/download only works for published (non-draft) releases."
    echo "Try a specific version: OFFICECLI_VERSION=v0.1.2 curl -fsSL ... | bash"
fi

# Step 2: Fallback to local files
if [ -z "$SOURCE" ]; then
    echo "Looking for local binary..."
    for candidate in "./$ASSET" "./$BINARY_NAME" "./bin/$ASSET" "./bin/$BINARY_NAME" "./dist/$ASSET" "./target/release/$BINARY_NAME"; do
        if [ -f "$candidate" ]; then
            if [ ! -x "$candidate" ]; then
                chmod +x "$candidate"
            fi
            if "$candidate" --version >/dev/null 2>&1; then
                SOURCE="$candidate"
                echo "Found valid binary at $candidate"
                break
            fi
        fi
    done
fi

if [ -z "$SOURCE" ]; then
    echo "Error: Could not find a valid OfficeCLI binary."
    echo "Download manually from: https://github.com/$REPO/releases"
    exit 1
fi

# Step 3: Install
EXISTING=$(command -v "$BINARY_NAME" 2>/dev/null || true)
if [ -n "$EXISTING" ]; then
    INSTALL_DIR=$(dirname "$EXISTING")
    echo "Found existing installation at $EXISTING, upgrading..."
else
    INSTALL_DIR="$HOME/.local/bin"
fi

mkdir -p "$INSTALL_DIR"
cp "$SOURCE" "$INSTALL_DIR/$BINARY_NAME.new"
chmod +x "$INSTALL_DIR/$BINARY_NAME.new"

if [ "$(uname -s)" = "Darwin" ]; then
    xattr -d com.apple.quarantine "$INSTALL_DIR/$BINARY_NAME.new" 2>/dev/null || true
    codesign -s - -f "$INSTALL_DIR/$BINARY_NAME.new" 2>/dev/null || true
fi

mv -f "$INSTALL_DIR/$BINARY_NAME.new" "$INSTALL_DIR/$BINARY_NAME"

case ":$PATH:" in
    *":$INSTALL_DIR:"*) ;;
    *)
        PATH_LINE="export PATH=\"$INSTALL_DIR:\$PATH\""
        if [ "$(uname -s)" = "Darwin" ]; then
            SHELL_RC="$HOME/.zshrc"
        elif [ -n "$ZSH_VERSION" ]; then
            SHELL_RC="$HOME/.zshrc"
        else
            SHELL_RC="$HOME/.bashrc"
        fi
        if ! grep -qF "$INSTALL_DIR" "$SHELL_RC" 2>/dev/null; then
            echo "" >> "$SHELL_RC"
            echo "$PATH_LINE" >> "$SHELL_RC"
            echo "Added $INSTALL_DIR to PATH in $SHELL_RC"
            echo "Run 'source $SHELL_RC' or restart your terminal to apply."
        fi
        ;;
esac

rm -f "/tmp/$BINARY_NAME"

# Step 4: Install AI agent skills (first install only)
SKILL_MARKER="$INSTALL_DIR/.officecli-skills-installed"
if [ ! -f "$SKILL_MARKER" ]; then
    SKILL_TARGETS=""
    for tool_dir in "$HOME/.claude:Claude Code" "$HOME/.copilot:GitHub Copilot" "$HOME/.agents:Codex CLI" "$HOME/.cursor:Cursor" "$HOME/.windsurf:Windsurf" "$HOME/.minimax:MiniMax CLI" "$HOME/.openclaw:OpenClaw" "$HOME/.nanobot/workspace:NanoBot" "$HOME/.zeroclaw/workspace:ZeroClaw" "$HOME/.hermes:Hermes Agent"; do
        dir="${tool_dir%%:*}"
        name="${tool_dir##*:}"
        if [ -d "$dir" ]; then
            SKILL_TARGETS="$SKILL_TARGETS $dir/skills/officecli"
            echo "$name detected."
        fi
    done

    if [ -n "$SKILL_TARGETS" ]; then
        echo "Downloading officecli skill..."
        if curl -fsSL --max-time 300 "$GITHUB_RAW_BASE/SKILL.md" -o "/tmp/officecli-skill.md" 2>/dev/null; then
            for target in $SKILL_TARGETS; do
                mkdir -p "$target"
                cp "/tmp/officecli-skill.md" "$target/SKILL.md"
                echo "  Installed: $target/SKILL.md"
            done
            rm -f "/tmp/officecli-skill.md"
        fi
    fi
    touch "$SKILL_MARKER"
fi

echo "OfficeCLI installed successfully!"
echo "Run 'officecli --help' to get started."
