<#
.SYNOPSIS
    Install or upgrade codex-jev, claude-jev, and jev-logs on Windows.

.DESCRIPTION
    Downloads prebuilt codex-jev, claude-jev, and jev-logs binaries,
    verifies their SHA-256 checksums, and installs them to the user-local
    application directory.

    Usage (public repository, once public):
      irm https://raw.githubusercontent.com/guanghuang/coding-router-jev/main/install.ps1 | iex

    Usage (private repository or download-and-review):
      $env:GH_TOKEN = "ghp_..."
      irm https://raw.githubusercontent.com/guanghuang/coding-router-jev/main/install.ps1 -OutFile install.ps1
      Get-Content install.ps1   # review the script
      .\install.ps1

    The installer never modifies ~/.coding-router-jev.env. It updates the
    user PATH (not the system PATH) without administrator privileges or
    duplicate entries.

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
$Script:ClaudeBinaryName = 'claude-jev'
$Script:JevLogsBinaryName = 'jev-logs'
$Script:AssetName = 'codex-jev-windows-x64.exe'
$Script:ClaudeAssetName = 'claude-jev-windows-x64.exe'
$Script:JevLogsAssetName = 'jev-logs-windows-x64.exe'
$Script:TempDir = $null

# ── Helpers ──────────────────────────────────────────────────────────────────

function Write-Log { param([string]$Message) Write-Host $Message }

function Exit-WithError {
    param([string]$Message)
    Write-Error "error: $Message"
    exit 1
}

# ── Help ─────────────────────────────────────────────────────────────────────

function Show-Help {
    @"
Install or upgrade codex-jev, claude-jev, and jev-logs on Windows.

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

The installer downloads prebuilt binaries for codex-jev, claude-jev,
and jev-logs, verifies their SHA-256 checksums, and places them in
the install directory. It adds the install directory to the user PATH
(not the system PATH) without administrator privileges or duplicate
entries. It never modifies ~/.coding-router-jev.env.

Prerequisites:
  codex-jev requires the Codex CLI (codex) installed and authenticated.
  claude-jev requires the Claude Code CLI (claude) installed and authenticated.

Uninstall:
  Remove-Item "`$env:LOCALAPPDATA\coding-router-jev\bin\codex-jev.exe"
  Remove-Item "`$env:LOCALAPPDATA\coding-router-jev\bin\claude-jev.exe"
  Remove-Item "`$env:LOCALAPPDATA\coding-router-jev\bin\jev-logs.exe"
  The installer only manages the binaries; ~/.coding-router-jev.env
  is yours to keep or remove.

Rollback:
  .\install.ps1 -Version v0.1.0   (pin the older version)
"@ | Write-Host
}

# ── Architecture detection ───────────────────────────────────────────────────

function Test-Architecture {
    $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    if ($arch -ieq 'X64') {
        Write-Log "Detected architecture: x64"
    }
    elseif ($arch -ieq 'Arm64') {
        Exit-WithError "Windows ARM64 is not supported. Only Windows x64 is supported."
    }
    else {
        Exit-WithError "unsupported architecture: $arch. Only Windows x64 is supported."
    }
}

# ── Version resolution ───────────────────────────────────────────────────────

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
        $response = Invoke-RestMethod -Uri $apiUrl -Headers $headers -TimeoutSec 60 -UseBasicParsing -ErrorAction Stop
    }
    catch {
        $statusCode = $null
        if ($_.Exception.Response) {
            $statusCode = [int]$_.Exception.Response.StatusCode
        }
        if (-not $statusCode -and $_.Exception.PSObject.Properties['StatusCode']) {
            $statusCode = [int]$_.Exception.StatusCode
        }
        $msg = $_.Exception.Message
        if ($statusCode -eq 401 -or $statusCode -eq 403 -or $msg -match 'Bad credentials') {
            Exit-WithError "authorization failed while trying to resolve latest version. Check GH_TOKEN or use 'gh auth login'."
        }
        elseif ($statusCode -eq 404 -or $msg -match 'Not Found') {
            Exit-WithError "release not found. Verify releases exist at https://github.com/$Script:Repo/releases"
        }
        else {
            Exit-WithError "failed to resolve latest version. Check your network connection and GH_TOKEN."
        }
    }

    $tag = $response.tag_name
    if (-not $tag) {
        Exit-WithError "could not determine latest release. Is the repository accessible? Try setting GH_TOKEN."
    }

    Write-Log "Latest release: $tag"
    return $tag
}

# ── Download ─────────────────────────────────────────────────────────────────

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
        Invoke-WebRequest -Uri $dlUrl -OutFile $Destination -Headers $headers -TimeoutSec 120 -UseBasicParsing -ErrorAction Stop
    }
    catch {
        $statusCode = $null
        if ($_.Exception.Response) {
            $statusCode = [int]$_.Exception.Response.StatusCode
        }
        if (-not $statusCode -and $_.Exception.PSObject.Properties['StatusCode']) {
            $statusCode = [int]$_.Exception.StatusCode
        }
        $msg = $_.Exception.Message
        if ($statusCode -eq 401 -or $statusCode -eq 403 -or $msg -match 'Bad credentials') {
            Exit-WithError "authorization failed while trying to download $AssetName. Check GH_TOKEN or use 'gh auth login'."
        }
        elseif ($statusCode -eq 404 -or $msg -match 'Not Found') {
            Exit-WithError "release asset not found: $AssetName for $Tag. Verify the version exists at https://github.com/$Script:Repo/releases"
        }
        else {
            Exit-WithError "failed to download $AssetName. Check your network connection and GH_TOKEN."
        }
    }
}

# ── Checksum verification ────────────────────────────────────────────────────

function Test-Checksum {
    param(
        [string]$FilePath,
        [string]$SumsFilePath
    )

    $fileName = Split-Path $FilePath -Leaf

    try {
        $sumsContent = Get-Content $SumsFilePath -Raw
    }
    catch {
        Exit-WithError "cannot read SHA256SUMS file: $_"
    }

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

    try {
        $actualHash = (Get-FileHash -Path $FilePath -Algorithm SHA256).Hash
    }
    catch {
        Exit-WithError "cannot compute SHA-256 hash for $fileName`: $_"
    }

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

# ── Install ──────────────────────────────────────────────────────────────────

function Install-Binary {
    param(
        [string]$Source,
        [string]$DestDir,
        [string]$Name
    )

    try {
        if (-not (Test-Path $DestDir)) {
            New-Item -Path $DestDir -ItemType Directory -Force | Out-Null
        }
    }
    catch {
        Exit-WithError "cannot create install directory $DestDir`: $_"
    }

    $dest = Join-Path $DestDir "$Name.exe"

    if (Test-Path $dest) {
        Write-Log "Replacing existing installation at $dest"

        $backupPath = "$dest.old"
        try {
            if (Test-Path $backupPath) {
                Remove-Item $backupPath -Force -ErrorAction SilentlyContinue
            }
            Rename-Item -Path $dest -NewName "$Name.exe.old" -Force -ErrorAction Stop
        }
        catch {
            Exit-WithError "cannot replace $dest. The file may be in use. Close any running $Name processes and try again."
        }
    }

    try {
        Copy-Item -Path $Source -Destination $dest -Force
    }
    catch {
        $backupPath = Join-Path $DestDir "$Name.exe.old"
        if (Test-Path $backupPath) {
            try {
                Rename-Item -Path $backupPath -NewName "$Name.exe" -Force
                Exit-WithError "upgrade failed; previous installation restored at $dest. The new binary could not be copied."
            }
            catch {
                Exit-WithError "upgrade failed and restore failed. The previous binary may be at $backupPath — rename it to $Name.exe manually."
            }
        }
        else {
            if (Test-Path $dest) {
                Remove-Item $dest -Force -ErrorAction SilentlyContinue
            }
            Exit-WithError "failed to install binary to $dest."
        }
    }

    # Clean up backup
    $backupPath = Join-Path $DestDir "$Name.exe.old"
    if (Test-Path $backupPath) {
        Remove-Item $backupPath -Force -ErrorAction SilentlyContinue
    }

    Write-Log "Installed $Name to $dest"
}

# ── PATH guidance ────────────────────────────────────────────────────────────

function Update-UserPath {
    param([string]$InstallDir)

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

    try {
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
    }
    catch {
        Write-Warning "Could not update persistent user PATH: $_"
        Write-Log "Add the install directory to your PATH manually:"
        Write-Log "  `$env:PATH = `"$InstallDir;`$env:PATH`""
    }

    $existing = Get-Command $Script:BinaryName -ErrorAction SilentlyContinue
    if ($existing -and $existing.Source -and
        $existing.Source -ine (Join-Path $InstallDir "$Script:BinaryName.exe")) {
        Write-Log ""
        Write-Log "Note: an existing $Script:BinaryName was found at $($existing.Source)."
        Write-Log "Ensure $InstallDir appears before $(Split-Path $existing.Source) in your PATH"
        Write-Log "to use the installer-managed binary."
    }
}

# ── Cleanup ──────────────────────────────────────────────────────────────────

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

    # Validate install directory does not contain path separator injection
    if ($Dir -and ($Dir -match '[;]' -or $Dir -match '[\r\n]')) {
        Exit-WithError "install directory must not contain semicolons or newline characters: $Dir"
    }

    # Resolve default install directory with a guard for missing LOCALAPPDATA
    if ($Dir) {
        $installDir = $Dir
    }
    else {
        $localAppData = $env:LOCALAPPDATA
        if (-not $localAppData) {
            $localAppData = [Environment]::GetFolderPath('LocalApplicationData')
        }
        if (-not $localAppData) {
            Exit-WithError "cannot determine local application data directory. Set -Dir or `$env:LOCALAPPDATA."
        }
        $installDir = Join-Path $localAppData 'coding-router-jev\bin'
    }

    Test-Architecture

    $Script:TempDir = Join-Path ([System.IO.Path]::GetTempPath()) "codex-jev-install-$([System.Guid]::NewGuid().ToString('N').Substring(0,8))"
    New-Item -Path $Script:TempDir -ItemType Directory -Force | Out-Null

    try {
        $tag = Resolve-ReleaseVersion -PinnedVersion $Version

        $assetDest = Join-Path $Script:TempDir $Script:AssetName
        Get-ReleaseAsset -Tag $tag -AssetName $Script:AssetName -Destination $assetDest

        $claudeAssetDest = Join-Path $Script:TempDir $Script:ClaudeAssetName
        Get-ReleaseAsset -Tag $tag -AssetName $Script:ClaudeAssetName -Destination $claudeAssetDest

        $jevLogsAssetDest = Join-Path $Script:TempDir $Script:JevLogsAssetName
        Get-ReleaseAsset -Tag $tag -AssetName $Script:JevLogsAssetName -Destination $jevLogsAssetDest

        $sumsDest = Join-Path $Script:TempDir 'SHA256SUMS'
        Get-ReleaseAsset -Tag $tag -AssetName 'SHA256SUMS' -Destination $sumsDest

        Test-Checksum -FilePath $assetDest -SumsFilePath $sumsDest
        Test-Checksum -FilePath $claudeAssetDest -SumsFilePath $sumsDest
        Test-Checksum -FilePath $jevLogsAssetDest -SumsFilePath $sumsDest

        Install-Binary -Source $assetDest -DestDir $installDir -Name $Script:BinaryName
        Install-Binary -Source $claudeAssetDest -DestDir $installDir -Name $Script:ClaudeBinaryName
        Install-Binary -Source $jevLogsAssetDest -DestDir $installDir -Name $Script:JevLogsBinaryName

        Update-UserPath -InstallDir $installDir

        Write-Log ""
        Write-Log "Done! Run '$Script:BinaryName --help' or '$Script:ClaudeBinaryName --help' to get started."
        Write-Log ""
        Write-Log "Prerequisites:"
        Write-Log "  codex-jev requires the Codex CLI (codex) installed and authenticated separately."
        Write-Log "  claude-jev requires Claude Code CLI (claude) installed and authenticated separately."
        Write-Log "  See https://github.com/openai/codex and https://code.claude.com for installation."
        Write-Log ""
        Write-Log "Uninstall:"
        Write-Log "  Remove-Item '$(Join-Path $installDir "$Script:BinaryName.exe")'"
        Write-Log "  Remove-Item '$(Join-Path $installDir "$Script:ClaudeBinaryName.exe")'"
        Write-Log "  Remove-Item '$(Join-Path $installDir "$Script:JevLogsBinaryName.exe")'"
    }
    finally {
        Remove-TempDir
    }
}

Main
