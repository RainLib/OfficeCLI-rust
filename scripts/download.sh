#!/usr/bin/env bash
# Download OfficeCLI release binaries from GitHub Releases.
#
# Usage:
#   ./scripts/download.sh                  # current platform, latest release
#   ./scripts/download.sh v0.1.2           # current platform, specific tag
#   ./scripts/download.sh v0.1.2 all       # all published platforms
#   ./scripts/download.sh latest mac-arm64 # one platform alias
#
# Platform aliases:
#   mac-arm64, mac-x64, linux-x64, linux-arm64, linux-alpine-x64,
#   win-x64, win-arm64
set -euo pipefail

REPO="RainLib/Foldly"
VERSION="${1:-latest}"
PLATFORM="${2:-auto}"
OUT_DIR="${OUT_DIR:-dist}"

ALL_ASSETS=(
    officecli-mac-arm64
    officecli-mac-x64
    officecli-linux-x64
    officecli-linux-arm64
    officecli-linux-alpine-x64
    officecli-win-x64.exe
    officecli-win-arm64.exe
)

resolve_asset() {
    local alias="$1"
    case "$alias" in
        mac-arm64|macos-arm64) echo "officecli-mac-arm64" ;;
        mac-x64|macos-x64) echo "officecli-mac-x64" ;;
        linux-x64) echo "officecli-linux-x64" ;;
        linux-arm64) echo "officecli-linux-arm64" ;;
        linux-alpine-x64|alpine-x64) echo "officecli-linux-alpine-x64" ;;
        win-x64|windows-x64) echo "officecli-win-x64.exe" ;;
        win-arm64|windows-arm64) echo "officecli-win-arm64.exe" ;;
        officecli-*) echo "$alias" ;;
        *) echo "Unknown platform: $alias" >&2; return 1 ;;
    esac
}

detect_asset() {
    local os arch libc
    os=$(uname -s | tr '[:upper:]' '[:lower:]')
    arch=$(uname -m)
    case "$os" in
        darwin)
            case "$arch" in
                arm64) resolve_asset mac-arm64 ;;
                x86_64) resolve_asset mac-x64 ;;
                *) echo "Unsupported architecture: $arch" >&2; return 1 ;;
            esac
            ;;
        linux)
            libc=gnu
            if command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; then
                libc=musl
            elif [ -f /etc/alpine-release ]; then
                libc=musl
            fi
            case "$arch" in
                x86_64)
                    if [ "$libc" = musl ]; then resolve_asset linux-alpine-x64
                    else resolve_asset linux-x64; fi
                    ;;
                aarch64|arm64) resolve_asset linux-arm64 ;;
                *) echo "Unsupported architecture: $arch" >&2; return 1 ;;
            esac
            ;;
        *)
            echo "Unsupported OS: $os (use a platform alias or download on Windows via install.ps1)" >&2
            return 1
            ;;
    esac
}

if [ "$VERSION" = "latest" ]; then
    BASE_URL="https://github.com/$REPO/releases/latest/download"
else
    BASE_URL="https://github.com/$REPO/releases/download/$VERSION"
fi

mkdir -p "$OUT_DIR"

download_one() {
    local asset="$1"
    local dest="$OUT_DIR/$asset"
    echo "Downloading $asset ..."
    curl -fsSL --max-time 300 "$BASE_URL/$asset" -o "$dest"
    if [[ "$asset" != *.exe ]]; then
        chmod +x "$dest"
    fi
}

if [ "$PLATFORM" = "all" ]; then
    for asset in "${ALL_ASSETS[@]}"; do
        download_one "$asset"
    done
    (
        cd "$OUT_DIR"
        sha256sum officecli-* > SHA256SUMS 2>/dev/null || shasum -a 256 officecli-* > SHA256SUMS
    )
    echo "Downloaded all assets to $OUT_DIR/"
    cat "$OUT_DIR/SHA256SUMS"
    exit 0
fi

if [ "$PLATFORM" = "auto" ]; then
    ASSET=$(detect_asset)
else
    ASSET=$(resolve_asset "$PLATFORM")
fi

download_one "$ASSET"

if curl -fsSL --max-time 300 "$BASE_URL/SHA256SUMS" -o "$OUT_DIR/SHA256SUMS" 2>/dev/null; then
    expected=$(grep "$ASSET" "$OUT_DIR/SHA256SUMS" | awk '{print $1}')
    if [ -n "$expected" ]; then
        if command -v sha256sum >/dev/null 2>&1; then
            actual=$(sha256sum "$OUT_DIR/$ASSET" | awk '{print $1}')
        else
            actual=$(shasum -a 256 "$OUT_DIR/$ASSET" | awk '{print $1}')
        fi
        if [ "$expected" = "$actual" ]; then
            echo "Checksum verified."
        else
            echo "Checksum mismatch for $ASSET" >&2
            exit 1
        fi
    fi
fi

echo "Saved: $OUT_DIR/$ASSET"
