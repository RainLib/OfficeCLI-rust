$repo = "RainLib/Foldly"
$binary = "officecli.exe"
$githubRawBase = "https://raw.githubusercontent.com/$repo/main"

# Optional: pin a release tag, e.g. $env:OFFICECLI_VERSION = "v0.1.2"
$version = if ($env:OFFICECLI_VERSION) { $env:OFFICECLI_VERSION } else { "latest" }
if ($version -eq "latest") {
    $releaseBase = "https://github.com/$repo/releases/latest/download"
} else {
    $releaseBase = "https://github.com/$repo/releases/download/$version"
}

# Detect Windows architecture
if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") {
    $asset = "officecli-win-arm64.exe"
} else {
    $asset = "officecli-win-x64.exe"
}

$source = $null

# Step 1: Download from GitHub Release
$tempFile = "$env:TEMP\$binary"
Write-Host "Downloading OfficeCLI ($asset) from $repo..."
try {
    Invoke-WebRequest -Uri "$releaseBase/$asset" -OutFile $tempFile -TimeoutSec 300 -ErrorAction Stop

    $checksumOk = $false
    $checksumFile = "$env:TEMP\officecli-SHA256SUMS"
    try {
        Invoke-WebRequest -Uri "$releaseBase/SHA256SUMS" -OutFile $checksumFile -TimeoutSec 300 -ErrorAction Stop
        $checksumContent = Get-Content $checksumFile
        $expectedLine = $checksumContent | Where-Object { $_ -match $asset }
        if ($expectedLine) {
            $expected = ($expectedLine -split '\s+')[0]
            $actual = (Get-FileHash -Path $tempFile -Algorithm SHA256).Hash.ToLower()
            if ($expected -eq $actual) {
                $checksumOk = $true
                Write-Host "Checksum verified."
            } else {
                Write-Host "Checksum mismatch! Expected: $expected, Got: $actual"
                Remove-Item -Force $tempFile, $checksumFile -ErrorAction SilentlyContinue
                exit 1
            }
        }
        Remove-Item -Force $checksumFile -ErrorAction SilentlyContinue
    } catch {
        Write-Host "Checksum file not available, skipping verification."
    }

    $output = & $tempFile --version 2>&1
    if ($LASTEXITCODE -eq 0) {
        $source = $tempFile
        Write-Host "Download verified."
    } else {
        Write-Host "Downloaded file is not a valid OfficeCLI binary."
        Remove-Item -Force $tempFile -ErrorAction SilentlyContinue
    }
} catch {
    Write-Host "Download failed."
    Write-Host "Tip: releases/latest/download only works for published (non-draft) releases."
    Write-Host "Try: `$env:OFFICECLI_VERSION='v0.1.2'; irm https://raw.githubusercontent.com/$repo/main/install.ps1 | iex"
}

# Step 2: Fallback to local files
if (-not $source) {
    Write-Host "Looking for local binary..."
    $candidates = @(".\$asset", ".\$binary", ".\bin\$asset", ".\bin\$binary", ".\dist\$asset", ".\target\release\$binary")
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) {
            $output = & $candidate --version 2>&1
            if ($LASTEXITCODE -eq 0) {
                $source = $candidate
                Write-Host "Found valid binary at $candidate"
                break
            }
        }
    }
}

if (-not $source) {
    Write-Host "Error: Could not find a valid OfficeCLI binary."
    Write-Host "Download manually from: https://github.com/$repo/releases"
    exit 1
}

# Step 3: Install
$existing = Get-Command $binary -ErrorAction SilentlyContinue
if ($existing) {
    $installDir = Split-Path $existing.Source
    Write-Host "Found existing installation at $($existing.Source), upgrading..."
} else {
    $installDir = "$env:LOCALAPPDATA\OfficeCLI"
}

New-Item -ItemType Directory -Force -Path $installDir | Out-Null
Copy-Item -Force $source "$installDir\$binary"
Remove-Item -Force $tempFile -ErrorAction SilentlyContinue

$currentPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($currentPath -notlike "*$installDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$currentPath;$installDir", "User")
    Write-Host "Added $installDir to PATH (restart your terminal to take effect)."
}

# Step 4: Install AI agent skills (first install only)
$skillMarker = "$installDir\.officecli-skills-installed"
if (-not (Test-Path $skillMarker)) {
    $skillTargets = @()
    $tools = @{
        "$env:USERPROFILE\.claude" = "Claude Code"
        "$env:USERPROFILE\.copilot" = "GitHub Copilot"
        "$env:USERPROFILE\.agents" = "Codex CLI"
        "$env:USERPROFILE\.cursor" = "Cursor"
        "$env:USERPROFILE\.windsurf" = "Windsurf"
        "$env:USERPROFILE\.minimax" = "MiniMax CLI"
        "$env:USERPROFILE\.openclaw" = "OpenClaw"
        "$env:USERPROFILE\.nanobot\workspace" = "NanoBot"
        "$env:USERPROFILE\.zeroclaw\workspace" = "ZeroClaw"
        "$env:USERPROFILE\.hermes" = "Hermes Agent"
    }
    foreach ($dir in $tools.Keys) {
        if (Test-Path $dir) {
            $skillTargets += "$dir\skills\officecli"
            Write-Host "$($tools[$dir]) detected."
        }
    }

    if ($skillTargets.Count -gt 0) {
        Write-Host "Downloading officecli skill..."
        $tempSkill = "$env:TEMP\officecli-skill.md"
        try {
            Invoke-WebRequest -Uri "$githubRawBase/SKILL.md" -OutFile $tempSkill -TimeoutSec 300 -ErrorAction Stop
            foreach ($target in $skillTargets) {
                New-Item -ItemType Directory -Force -Path $target | Out-Null
                Copy-Item -Force $tempSkill "$target\SKILL.md"
                Write-Host "  Installed: $target\SKILL.md"
            }
            Remove-Item -Force $tempSkill -ErrorAction SilentlyContinue
        } catch {
            Write-Host "Skill download skipped."
        }
    }
    New-Item -ItemType File -Force -Path $skillMarker | Out-Null
}

Write-Host "OfficeCLI installed successfully!"
Write-Host "Run 'officecli --help' to get started."
