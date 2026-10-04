<#
.SYNOPSIS
    Install or upgrade codex-jev on Windows.

.DESCRIPTION
    Downloads a prebuilt codex-jev binary, verifies its SHA-256 checksum,
    and installs it to the user-local application directory.

    Usage (public repository, once public):
      irm https://raw.githubusercontent.com/guanghuang/coding-router-jev/main/install.ps1 | iex

    Usage (private repository or download-and-review):
      $env:GH_TOKEN = "ghp_..."
      irm https://raw.githubusercontent.com/guanghuang/coding-router-jev/main/install.ps1 -OutFile install.ps1
      Get-Content install.ps1   # review the script
      .\install.ps1

    The installer never modifies ~/.coding-router-jev.env.

.PARAMETER Version
    Pin a specific release tag (e.g. v0.1.0). Default: latest release.

.PARAMETER Dir
    Override the install directory.
    Default: $env:LOCALAPPDATA\coding-router-jev\bin

.PARAMETER Help
    Show usage information and exit.

.EXAMPLE
    .\install.ps1
    .\install.ps1 -Version v0.1.0
    .\install.ps1 -Dir C:\tools\bin
#>

[CmdletBinding()]
param(
    [string]$Version = '',
    [string]$Dir = '',
    [switch]$Help
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Script:Repo = 'guanghuang/coding-router-jev'
$Script:BinaryName = 'codex-jev'
$Script:AssetName = 'codex-jev-windows-x64.exe'
$Script:TempDir = $null

function Write-Log { param([string]$Message) Write-Host $Message }

function Exit-WithError {
    param([string]$Message)
    Write-Error "error: $Message"
    exit 1
}

function Show-Help {
    @"
Install or upgrade codex-jev on Windows.

Usage:
  install.ps1 [OPTIONS]

Options:
  -Version VERSION   Install a specific release (e.g. v0.1.0)
  -Dir DIRECTORY     Install directory
                     Default: `$env:LOCALAPPDATA\coding-router-jev\bin
  -Help              Show this help

Environment:
  CODEX_JEV_VERSION  Same as -Version
  INSTALL_DIR        Same as -Dir
  GH_TOKEN           GitHub token for private repository access

The installer downloads a prebuilt binary, verifies its SHA-256
checksum, and places it in the install directory. It never modifies
~/.coding-router-jev.env.

Prerequisites:
  The Codex CLI (codex) must be installed and authenticated separately.

Uninstall:
  Remove-Item "`$env:LOCALAPPDATA\coding-router-jev\bin\codex-jev.exe"
  The installer only manages the single binary; ~/.coding-router-jev.env
  is yours to keep or remove.

Rollback:
  .\install.ps1 -Version v0.1.0   (pin the older version)
"@ | Write-Host
}

function Test-Architecture {
    $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
    switch ($arch) {
        'X64' {
            Write-Log "Detected architecture: x64"
            return
        }
        'Arm64' {
            Exit-WithError "Windows ARM64 is not supported. Only Windows x64 is supported."
        }
        default {
            Exit-WithError "unsupported architecture: $arch. Only Windows x64 is supported."
        }
    }
}

function Resolve-ReleaseVersion {
    param([string]$PinnedVersion)

    if ($PinnedVersion) {
        Write-Log "Pinned version: $PinnedVersion"
        return $PinnedVersion
    }

    Write-Log "Resolving latest release..."

    $apiUrl = "https://api.github.com/repos/$Script:Repo/releases/latest"
    $headers = @{ 'Accept' = 'application/vnd.github+json' }

    $token = $env:GH_TOKEN
    if ($token) {
        $headers['Authorization'] = "token $token"
    }

    try {
        $response = Invoke-RestMethod -Uri $apiUrl -Headers $headers -ErrorAction Stop
    }
    catch {
        $statusCode = $null
        if ($_.Exception.Response) {
            $statusCode = [int]$_.Exception.Response.StatusCode
        }
        $msg = $_.Exception.Message
        if ($statusCode -eq 401 -or $statusCode -eq 403 -or $msg -match 'Bad credentials') {
            Exit-WithError "authorization failed while trying to resolve latest version. Check GH_TOKEN."
        }
        elseif ($statusCode -eq 404 -or $msg -match 'Not Found') {
            Exit-WithError "release not found. Verify releases exist at https://github.com/$Script:Repo/releases"
        }
        else {
            Exit-WithError "failed to resolve latest version. Check your network connection and GH_TOKEN. $_"
        }
    }

    $tag = $response.tag_name
    if (-not $tag) {
        Exit-WithError "could not determine latest release. Is the repository accessible? Try setting GH_TOKEN."
    }

    Write-Log "Latest release: $tag"
    return $tag
}

function Get-ReleaseAsset {
    param(
        [string]$Tag,
        [string]$AssetName,
        [string]$Destination
    )

    Write-Log "Downloading $AssetName..."

    $token = $env:GH_TOKEN
    $headers = @{}

    if ($token) {
        $dlUrl = "https://api.github.com/repos/$Script:Repo/releases/download/$Tag/$AssetName"
        $headers = @{
            'Authorization' = "token $token"
            'Accept'        = 'application/octet-stream'
        }
    }
    else {
        $dlUrl = "https://github.com/$Script:Repo/releases/download/$Tag/$AssetName"
    }

    try {
        Invoke-WebRequest -Uri $dlUrl -OutFile $Destination -Headers $headers -ErrorAction Stop
    }
    catch {
        $statusCode = $null
        if ($_.Exception.Response) {
            $statusCode = [int]$_.Exception.Response.StatusCode
        }
        $msg = $_.Exception.Message
        if ($statusCode -eq 401 -or $statusCode -eq 403 -or $msg -match 'Bad credentials') {
            Exit-WithError "authorization failed while trying to download $AssetName. Check GH_TOKEN."
        }
        elseif ($statusCode -eq 404 -or $msg -match 'Not Found') {
            Exit-WithError "release asset not found: $AssetName for $Tag. Verify the version exists at https://github.com/$Script:Repo/releases"
        }
        else {
            Exit-WithError "failed to download $AssetName. Check your network connection and GH_TOKEN. $_"
        }
    }
}

function Test-Checksum {
    param(
        [string]$FilePath,
        [string]$SumsFilePath
    )

    $fileName = Split-Path $FilePath -Leaf
    $sumsContent = Get-Content $SumsFilePath -Raw

    $expectedHash = $null
    foreach ($line in $sumsContent -split "`n") {
        $line = $line.Trim()
        if ($line -match "^([0-9a-fA-F]{64})\s+$([regex]::Escape($fileName))$") {
            $expectedHash = $Matches[1]
            break
        }
    }

    if (-not $expectedHash) {
        Exit-WithError "no checksum found for $fileName in SHA256SUMS"
    }

    $actualHash = (Get-FileHash -Path $FilePath -Algorithm SHA256).Hash

    if ($actualHash -ine $expectedHash) {
        Exit-WithError @"
checksum mismatch for ${fileName}:
  expected: $expectedHash
  actual:   $actualHash
The downloaded file may be corrupted or tampered with.
"@
    }

    Write-Log "Checksum verified: $fileName"
}

function Install-Binary {
    param(
        [string]$Source,
        [string]$DestDir
    )

    if (-not (Test-Path $DestDir)) {
        New-Item -Path $DestDir -ItemType Directory -Force | Out-Null
    }

    $dest = Join-Path $DestDir "$Script:BinaryName.exe"

    if (Test-Path $dest) {
        Write-Log "Replacing existing installation at $dest"

        # Handle potentially locked executable by renaming first
        $backupPath = "$dest.old"
        try {
            if (Test-Path $backupPath) {
                Remove-Item $backupPath -Force -ErrorAction SilentlyContinue
            }
            Rename-Item -Path $dest -NewName "$Script:BinaryName.exe.old" -Force -ErrorAction Stop
        }
        catch {
            Exit-WithError "cannot replace $dest. The file may be in use. Close any running codex-jev processes and try again."
        }
    }

    try {
        Copy-Item -Path $Source -Destination $dest -Force
    }
    catch {
        # Restore backup on failure
        $backupPath = Join-Path $DestDir "$Script:BinaryName.exe.old"
        if (Test-Path $backupPath) {
            try {
                Rename-Item -Path $backupPath -NewName "$Script:BinaryName.exe" -Force
            }
            catch {}
        }
        Exit-WithError "failed to install binary to $dest. $_"
    }

    # Clean up backup
    $backupPath = Join-Path $DestDir "$Script:BinaryName.exe.old"
    if (Test-Path $backupPath) {
        Remove-Item $backupPath -Force -ErrorAction SilentlyContinue
    }

    Write-Log "Installed $Script:BinaryName to $dest"
}

function Update-UserPath {
    param([string]$InstallDir)

    # Check if already in current session PATH
    $currentPath = $env:PATH
    $pathEntries = $currentPath -split ';' | Where-Object { $_ -ne '' }
    $normalizedDir = $InstallDir.TrimEnd('\')

    $alreadyInSession = $pathEntries | Where-Object {
        $_.TrimEnd('\') -ieq $normalizedDir
    }

    if (-not $alreadyInSession) {
        $env:PATH = "$InstallDir;$env:PATH"
        Write-Log "Added $InstallDir to current session PATH."
    }

    # Check and update persistent user PATH
    $userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
    if (-not $userPath) { $userPath = '' }

    $userEntries = $userPath -split ';' | Where-Object { $_ -ne '' }
    $alreadyPersisted = $userEntries | Where-Object {
        $_.TrimEnd('\') -ieq $normalizedDir
    }

    if (-not $alreadyPersisted) {
        $newUserPath = if ($userPath) { "$InstallDir;$userPath" } else { $InstallDir }
        [Environment]::SetEnvironmentVariable('PATH', $newUserPath, 'User')
        Write-Log "Added $InstallDir to user PATH (persistent)."
        Write-Log ""
        Write-Log "The install directory is available in this session."
        Write-Log "Open a new terminal for other shells to pick up the change."
    }
    else {
        Write-Log "Install directory already in user PATH."
    }

    # Warn about shadowing
    $existing = Get-Command $Script:BinaryName -ErrorAction SilentlyContinue
    if ($existing -and $existing.Source -and
        $existing.Source -ine (Join-Path $InstallDir "$Script:BinaryName.exe")) {
        Write-Log ""
        Write-Log "Note: an existing $Script:BinaryName was found at $($existing.Source)."
        Write-Log "Ensure $InstallDir appears before $(Split-Path $existing.Source) in your PATH"
        Write-Log "to use the installer-managed binary."
    }
}

function Remove-TempDir {
    if ($Script:TempDir -and (Test-Path $Script:TempDir)) {
        Remove-Item $Script:TempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# ── Main ─────────────────────────────────────────────────────────────────────

function Main {
    if ($Help) {
        Show-Help
        return
    }

    # Environment variable fallbacks
    if (-not $Version -and $env:CODEX_JEV_VERSION) {
        $Version = $env:CODEX_JEV_VERSION
    }
    if (-not $Dir -and $env:INSTALL_DIR) {
        $Dir = $env:INSTALL_DIR
    }

    $installDir = if ($Dir) { $Dir } else { Join-Path $env:LOCALAPPDATA 'coding-router-jev\bin' }

    Test-Architecture

    $Script:TempDir = Join-Path ([System.IO.Path]::GetTempPath()) "codex-jev-install-$([System.Guid]::NewGuid().ToString('N').Substring(0,8))"
    New-Item -Path $Script:TempDir -ItemType Directory -Force | Out-Null

    try {
        $tag = Resolve-ReleaseVersion -PinnedVersion $Version

        $assetDest = Join-Path $Script:TempDir $Script:AssetName
        Get-ReleaseAsset -Tag $tag -AssetName $Script:AssetName -Destination $assetDest

        $sumsDest = Join-Path $Script:TempDir 'SHA256SUMS'
        Get-ReleaseAsset -Tag $tag -AssetName 'SHA256SUMS' -Destination $sumsDest

        Test-Checksum -FilePath $assetDest -SumsFilePath $sumsDest

        Install-Binary -Source $assetDest -DestDir $installDir

        Update-UserPath -InstallDir $installDir

        Write-Log ""
        Write-Log "Done! Run '$Script:BinaryName --help' to get started."
        Write-Log ""
        Write-Log "Prerequisites:"
        Write-Log "  The Codex CLI (codex) must be installed and authenticated separately."
        Write-Log "  See https://github.com/openai/codex for installation instructions."
        Write-Log ""
        Write-Log "Uninstall:"
        Write-Log "  Remove-Item '$(Join-Path $installDir "$Script:BinaryName.exe")'"
    }
    finally {
        Remove-TempDir
    }
}

Main
