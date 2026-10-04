#!/bin/sh
# install.sh — Install or upgrade codex-jev on macOS and Linux.
#
# Usage (public repository):
#   curl -fsSL https://raw.githubusercontent.com/guanghuang/coding-router-jev/main/install.sh | sh
#
# Usage (private repository or local script):
#   GH_TOKEN=ghp_... sh install.sh
#   sh install.sh --version v0.1.0
#   sh install.sh --dir /usr/local/bin
#
# Environment variables:
#   CODEX_JEV_VERSION   Pin a specific release tag (e.g. v0.1.0)
#   INSTALL_DIR         Override the install directory (default: ~/.local/bin)
#   GH_TOKEN            GitHub token for private repository access
#
# The installer never modifies ~/.coding-router-jev.env or shell startup files.

set -eu

REPO="guanghuang/coding-router-jev"
BINARY_NAME="codex-jev"
DEFAULT_INSTALL_DIR="$HOME/.local/bin"

# ── Helpers ──────────────────────────────────────────────────────────────────

log()   { printf '%s\n' "$*"; }
warn()  { printf '%s\n' "$*" >&2; }
die()   { warn "error: $*"; exit 1; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

# ── Argument parsing ─────────────────────────────────────────────────────────

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --version)
        [ $# -ge 2 ] || die "--version requires a value"
        CODEX_JEV_VERSION="$2"; shift 2 ;;
      --version=*)
        CODEX_JEV_VERSION="${1#--version=}"; shift ;;
      --dir)
        [ $# -ge 2 ] || die "--dir requires a value"
        INSTALL_DIR="$2"; shift 2 ;;
      --dir=*)
        INSTALL_DIR="${1#--dir=}"; shift ;;
      --help|-h)
        show_help; exit 0 ;;
      *)
        die "unknown option: $1" ;;
    esac
  done
}

show_help() {
  cat <<'HELP'
Install or upgrade codex-jev.

Usage:
  install.sh [OPTIONS]

Options:
  --version VERSION   Install a specific release (e.g. v0.1.0)
  --dir DIRECTORY     Install directory (default: ~/.local/bin)
  --help, -h          Show this help

Environment:
  CODEX_JEV_VERSION   Same as --version
  INSTALL_DIR         Same as --dir
  GH_TOKEN            GitHub token for private repository access

The installer downloads a prebuilt binary, verifies its SHA-256
checksum, and places it in the install directory. It never modifies
~/.coding-router-jev.env or shell startup files.

Prerequisites:
  The Codex CLI (codex) must be installed and authenticated separately.

Uninstall:
  rm ~/.local/bin/codex-jev   (or your custom --dir path)
  The installer only manages the single binary; ~/.coding-router-jev.env
  is yours to keep or remove.

Rollback:
  install.sh --version v0.1.0   (pin the older version)
HELP
}

# ── Platform detection ───────────────────────────────────────────────────────

detect_platform() {
  OS="$(uname -s)"
  ARCH="$(uname -m)"

  case "$OS" in
    Darwin)  PLATFORM_OS="darwin" ;;
    Linux)   PLATFORM_OS="linux" ;;
    *)       die "unsupported operating system: $OS (macOS and Linux only)" ;;
  esac

  case "$ARCH" in
    x86_64|amd64)   PLATFORM_ARCH="x64" ;;
    aarch64|arm64)   PLATFORM_ARCH="arm64" ;;
    *)               die "unsupported architecture: $ARCH" ;;
  esac

  if [ "$PLATFORM_OS" = "linux" ]; then
    check_musl
  fi

  ASSET_NAME="${BINARY_NAME}-${PLATFORM_OS}-${PLATFORM_ARCH}"
  log "Detected platform: ${PLATFORM_OS}/${PLATFORM_ARCH} (asset: ${ASSET_NAME})"
}

check_musl() {
  if [ -f /etc/alpine-release ]; then
    die "Alpine Linux (musl) is not supported. glibc Linux is required."
  fi
  # shellcheck disable=SC2044
  for f in /lib/ld-musl-*; do
    if [ -e "$f" ]; then
      die "musl libc detected ($f). glibc Linux is required."
    fi
    break
  done
}

# ── Version resolution ───────────────────────────────────────────────────────

resolve_version() {
  if [ -n "${CODEX_JEV_VERSION:-}" ]; then
    TAG="$CODEX_JEV_VERSION"
    log "Pinned version: $TAG"
    return
  fi

  log "Resolving latest release..."

  if [ -n "${GH_TOKEN:-}" ]; then
    TAG=$(curl -fsSL \
      -H "Authorization: token ${GH_TOKEN}" \
      -H "Accept: application/vnd.github+json" \
      "https://api.github.com/repos/${REPO}/releases/latest" 2>&1) || {
      handle_api_error "$TAG" "resolve latest version"
    }
  else
    TAG=$(curl -fsSL \
      -H "Accept: application/vnd.github+json" \
      "https://api.github.com/repos/${REPO}/releases/latest" 2>&1) || {
      handle_api_error "$TAG" "resolve latest version"
    }
  fi

  # Extract tag_name from JSON without jq dependency
  TAG=$(printf '%s' "$TAG" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
  [ -n "$TAG" ] || die "could not determine latest release. Is the repository accessible? Try setting GH_TOKEN."

  log "Latest release: $TAG"
}

handle_api_error() {
  _body="$1"
  _action="$2"
  case "$_body" in
    *"401"*|*"403"*|*"Bad credentials"*|*"must have"*)
      die "authorization failed while trying to ${_action}. Check GH_TOKEN or use 'gh auth login'." ;;
    *"404"*|*"Not Found"*)
      die "release not found while trying to ${_action}. Verify the version exists at https://github.com/${REPO}/releases" ;;
    *)
      die "failed to ${_action}: ${_body}" ;;
  esac
}

# ── Download ─────────────────────────────────────────────────────────────────

download_asset() {
  _asset="$1"
  _dest="$2"

  _url="https://github.com/${REPO}/releases/download/${TAG}/${_asset}"
  log "Downloading ${_asset}..."

  _curl_args="-fSL"
  if [ -n "${GH_TOKEN:-}" ]; then
    _curl_args="$_curl_args -H 'Authorization: token ${GH_TOKEN}'"
    _curl_args="$_curl_args -H 'Accept: application/octet-stream'"

    if ! eval curl "$_curl_args" -o "'$_dest'" "'https://api.github.com/repos/${REPO}/releases/download/${TAG}/${_asset}'" 2>"${TMPDIR_INSTALL}/curl_err"; then
      _err=$(cat "${TMPDIR_INSTALL}/curl_err" 2>/dev/null || true)
      handle_api_error "$_err" "download ${_asset}"
    fi
  else
    if ! curl -fSL -o "$_dest" "$_url" 2>"${TMPDIR_INSTALL}/curl_err"; then
      _err=$(cat "${TMPDIR_INSTALL}/curl_err" 2>/dev/null || true)
      handle_api_error "$_err" "download ${_asset}"
    fi
  fi
}

# ── Checksum verification ────────────────────────────────────────────────────

verify_checksum() {
  _file="$1"
  _sums_file="$2"

  _basename=$(basename "$_file")
  _expected=$(grep "  ${_basename}\$" "$_sums_file" | cut -d' ' -f1)
  [ -n "$_expected" ] || die "no checksum found for ${_basename} in SHA256SUMS"

  if command -v sha256sum >/dev/null 2>&1; then
    _actual=$(sha256sum "$_file" | cut -d' ' -f1)
  elif command -v shasum >/dev/null 2>&1; then
    _actual=$(shasum -a 256 "$_file" | cut -d' ' -f1)
  else
    die "no SHA-256 tool found. Install sha256sum or shasum."
  fi

  if [ "$_actual" != "$_expected" ]; then
    die "checksum mismatch for ${_basename}:
  expected: ${_expected}
  actual:   ${_actual}
The downloaded file may be corrupted or tampered with."
  fi

  log "Checksum verified: ${_basename}"
}

# ── Install ──────────────────────────────────────────────────────────────────

install_binary() {
  _src="$1"
  _dest_dir="$2"

  mkdir -p "$_dest_dir" || die "cannot create install directory: $_dest_dir"

  _dest="${_dest_dir}/${BINARY_NAME}"

  if [ -f "$_dest" ]; then
    log "Replacing existing installation at ${_dest}"
  fi

  chmod +x "$_src"
  mv "$_src" "$_dest" || die "failed to install binary to ${_dest}"

  log "Installed ${BINARY_NAME} to ${_dest}"
}

# ── PATH guidance ────────────────────────────────────────────────────────────

print_path_help() {
  _dir="$1"

  case ":${PATH:-}:" in
    *":${_dir}:"*)
      return ;;
  esac

  log ""
  log "Add the install directory to your PATH:"
  log ""
  log "  export PATH=\"${_dir}:\$PATH\""
  log ""
  log "To make it permanent, add that line to your shell startup file"
  log "(e.g. ~/.bashrc, ~/.zshrc, or ~/.profile)."

  # Check if a source-installed codex-jev shadows the new binary
  _existing=$(command -v "$BINARY_NAME" 2>/dev/null || true)
  if [ -n "$_existing" ] && [ "$_existing" != "${_dir}/${BINARY_NAME}" ]; then
    log ""
    log "Note: an existing ${BINARY_NAME} was found at ${_existing}."
    log "Ensure ${_dir} appears before $(dirname "$_existing") in your PATH"
    log "to use the installer-managed binary."
  fi
}

# ── Cleanup ──────────────────────────────────────────────────────────────────

cleanup() {
  if [ -n "${TMPDIR_INSTALL:-}" ] && [ -d "${TMPDIR_INSTALL:-}" ]; then
    rm -rf "$TMPDIR_INSTALL"
  fi
}

# ── Main ─────────────────────────────────────────────────────────────────────

main() {
  parse_args "$@"

  need_cmd curl
  need_cmd uname

  INSTALL_DIR="${INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
  CODEX_JEV_VERSION="${CODEX_JEV_VERSION:-}"

  detect_platform
  resolve_version

  # Create temporary directory for downloads
  TMPDIR_INSTALL=$(mktemp -d "${TMPDIR:-/tmp}/codex-jev-install.XXXXXX") || die "cannot create temporary directory"
  trap cleanup EXIT

  download_asset "$ASSET_NAME" "${TMPDIR_INSTALL}/${ASSET_NAME}"
  download_asset "SHA256SUMS" "${TMPDIR_INSTALL}/SHA256SUMS"

  verify_checksum "${TMPDIR_INSTALL}/${ASSET_NAME}" "${TMPDIR_INSTALL}/SHA256SUMS"

  install_binary "${TMPDIR_INSTALL}/${ASSET_NAME}" "$INSTALL_DIR"

  print_path_help "$INSTALL_DIR"

  log ""
  log "Done! Run '${BINARY_NAME} --help' to get started."
  log ""
  log "Prerequisites:"
  log "  The Codex CLI (codex) must be installed and authenticated separately."
  log "  See https://github.com/openai/codex for installation instructions."
  log ""
  log "Uninstall:"
  log "  rm '${INSTALL_DIR}/${BINARY_NAME}'"
}

main "$@"
