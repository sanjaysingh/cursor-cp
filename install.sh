#!/usr/bin/env bash
#
# Cursor Control Plane installer (per-user, no sudo).
#
# Clones (or upgrades) the project, installs dependencies, builds it, writes your
# configuration, and adds a `cursor-cp` launcher to ~/.local/bin.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/sanjaysingh/cursor-cp/main/install.sh | bash
#   bash install.sh [--version <ref>] [--dir <path>] [--help]
#

# Must run under bash (the one-liner pipes to `bash`). Fail clearly under sh/dash.
if [ -z "${BASH_VERSION:-}" ]; then
    echo "This installer requires bash. Re-run it with:" >&2
    echo "  curl -fsSL https://raw.githubusercontent.com/sanjaysingh/cursor-cp/main/install.sh | bash" >&2
    exit 1
fi

set -euo pipefail

# --- Settings ---------------------------------------------------------------

readonly REPO_URL="https://github.com/sanjaysingh/cursor-cp.git"
readonly MIN_NODE_MAJOR=20

INSTALL_DIR="${CURSOR_CP_INSTALL_DIR:-$HOME/.local/share/cursor-cp}"
VERSION="${CURSOR_CP_VERSION:-latest}"
BIN_DIR="$HOME/.local/bin"
LAUNCHER="$BIN_DIR/cursor-cp"

# --- Output helpers ---------------------------------------------------------

if [ -t 1 ]; then
    RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; BLUE=$'\033[0;34m'; NC=$'\033[0m'
else
    RED=''; GREEN=''; YELLOW=''; BLUE=''; NC=''
fi

log()     { printf '%s[cursor-cp]%s %s\n' "$BLUE" "$NC" "$1"; }
warn()    { printf '%s[warning]%s %s\n' "$YELLOW" "$NC" "$1" >&2; }
success() { printf '%s[ok]%s %s\n' "$GREEN" "$NC" "$1"; }
die()     { printf '%s[error]%s %s\n' "$RED" "$NC" "$1" >&2; exit 1; }

usage() {
    cat <<EOF
Cursor Control Plane installer

Usage: install.sh [OPTIONS]

Options:
  --version <ref>   Git tag or branch to install (default: latest / main)
  --dir <path>      Install directory (default: ~/.local/share/cursor-cp)
  --help, -h        Show this help

Environment:
  CURSOR_API_KEY          Cursor API key (prompted if unset and running interactively)
  CURSOR_CP_VERSION       Same as --version
  CURSOR_CP_INSTALL_DIR   Same as --dir
EOF
}

# --- Argument parsing -------------------------------------------------------

while [ $# -gt 0 ]; do
    case "$1" in
        --version) [ $# -ge 2 ] || die "--version requires a value"; VERSION="$2"; shift 2 ;;
        --dir)     [ $# -ge 2 ] || die "--dir requires a value"; INSTALL_DIR="$2"; shift 2 ;;
        --help|-h) usage; exit 0 ;;
        *)         die "Unknown option: $1 (try --help)" ;;
    esac
done

LAUNCHER="$BIN_DIR/cursor-cp"

# --- Prerequisite checks ----------------------------------------------------

check_prerequisites() {
    log "Checking prerequisites..."

    case "$(uname -s)" in
        Linux*|Darwin*) ;;
        *) die "Unsupported OS: $(uname -s). This installer supports Linux and macOS." ;;
    esac

    command -v git  >/dev/null 2>&1 || die "git is required. Install it and try again."
    command -v node >/dev/null 2>&1 || die "Node.js ${MIN_NODE_MAJOR}+ is required: https://nodejs.org/"
    command -v npm  >/dev/null 2>&1 || die "npm is required (it ships with Node.js)."

    local node_major
    node_major="$(node -p 'process.versions.node.split(".")[0]')"
    if [ "$node_major" -lt "$MIN_NODE_MAJOR" ]; then
        die "Node.js ${MIN_NODE_MAJOR}+ is required. Found $(node -v)."
    fi
    log "Found Node.js $(node -v)"

    command -v gh >/dev/null 2>&1 || warn "GitHub CLI (gh) not found — GitHub repo browsing/cloning will be disabled."
}

# --- Install / upgrade ------------------------------------------------------

clone_or_update() {
    if [ -d "$INSTALL_DIR/.git" ]; then
        log "Upgrading existing install at $INSTALL_DIR"
        git -C "$INSTALL_DIR" fetch --tags --prune origin
        if [ "$VERSION" = "latest" ]; then
            git -C "$INSTALL_DIR" checkout main >/dev/null 2>&1 || git -C "$INSTALL_DIR" checkout master
            git -C "$INSTALL_DIR" pull --ff-only origin "$(git -C "$INSTALL_DIR" rev-parse --abbrev-ref HEAD)"
        else
            git -C "$INSTALL_DIR" checkout "$VERSION"
        fi
    elif [ -e "$INSTALL_DIR" ]; then
        die "$INSTALL_DIR exists but is not a git checkout. Remove it or pass --dir <path>."
    else
        log "Cloning into $INSTALL_DIR"
        mkdir -p "$(dirname "$INSTALL_DIR")"
        git clone "$REPO_URL" "$INSTALL_DIR"
        if [ "$VERSION" != "latest" ]; then
            git -C "$INSTALL_DIR" checkout "$VERSION"
        fi
    fi
}

build_app() {
    log "Installing dependencies..."
    if [ -f "$INSTALL_DIR/package-lock.json" ]; then
        ( cd "$INSTALL_DIR" && npm ci )
    else
        ( cd "$INSTALL_DIR" && npm install )
    fi

    log "Building..."
    ( cd "$INSTALL_DIR" && npm run build )
}

# --- API key ----------------------------------------------------------------

prompt() {
    # Read a value even when stdin is a pipe (curl | bash), using the terminal.
    local message="$1" silent="${2:-}" reply
    if [ -r /dev/tty ]; then
        if [ "$silent" = "silent" ]; then
            printf '%s' "$message" > /dev/tty
            read -rs reply < /dev/tty
            printf '\n' > /dev/tty
        else
            printf '%s' "$message" > /dev/tty
            read -r reply < /dev/tty
        fi
        printf '%s' "$reply"
    fi
}

resolve_api_key() {
    if [ -n "${CURSOR_API_KEY:-}" ]; then
        API_KEY="$CURSOR_API_KEY"
        return
    fi

    # Reuse an existing key if one is already configured.
    if [ -f "$INSTALL_DIR/.env" ] && grep -q '^CURSOR_API_KEY=..*' "$INSTALL_DIR/.env"; then
        local existing
        existing="$(grep '^CURSOR_API_KEY=' "$INSTALL_DIR/.env" | head -n1 | cut -d= -f2-)"
        if [ -n "$existing" ] && [ "${existing#your_}" = "$existing" ]; then
            API_KEY="$existing"
            log "Reusing the API key from the existing .env"
            return
        fi
    fi

    if [ ! -r /dev/tty ]; then
        die "CURSOR_API_KEY is not set and no terminal is available to prompt.
Set it and re-run, e.g.:  export CURSOR_API_KEY=cursor_...  &&  bash install.sh"
    fi

    printf '\nA Cursor API key is required. Get one at:\n  https://cursor.com/dashboard/cloud-agents\n\n' > /dev/tty
    API_KEY="$(prompt 'Enter your Cursor API key: ' silent)"
    [ -n "$API_KEY" ] || die "No API key entered."
    case "$API_KEY" in
        cursor_*) ;;
        *) warn "Key does not start with 'cursor_' — continuing anyway." ;;
    esac
}

# --- Configuration ----------------------------------------------------------

write_env() {
    local env_file="$INSTALL_DIR/.env"
    if [ -f "$env_file" ]; then
        # Update the key in place; leave the rest of the user's file untouched.
        local tmp
        tmp="$(mktemp)"
        if grep -q '^CURSOR_API_KEY=' "$env_file"; then
            sed "s|^CURSOR_API_KEY=.*|CURSOR_API_KEY=${API_KEY}|" "$env_file" > "$tmp"
        else
            cat "$env_file" > "$tmp"
            printf 'CURSOR_API_KEY=%s\n' "$API_KEY" >> "$tmp"
        fi
        mv "$tmp" "$env_file"
        log "Updated $env_file"
    else
        cat > "$env_file" <<EOF
# Cursor Control Plane configuration (generated by install.sh)

# Required: get a key at https://cursor.com/dashboard/cloud-agents
CURSOR_API_KEY=${API_KEY}

# Server
PORT=8080
HOST=0.0.0.0

# Logging: debug | info | warn | error
LOG_LEVEL=info
EOF
        log "Wrote $env_file"
    fi
    chmod 600 "$env_file" 2>/dev/null || true
}

create_launcher() {
    mkdir -p "$BIN_DIR"
    cat > "$LAUNCHER" <<EOF
#!/usr/bin/env bash
# Cursor Control Plane launcher (generated by install.sh)
exec node "${INSTALL_DIR}/dist/cli/index.js" "\$@"
EOF
    chmod +x "$LAUNCHER"
    log "Installed launcher at $LAUNCHER"
}

# --- Final summary ----------------------------------------------------------

print_summary() {
    success "Cursor Control Plane installed."
    printf '\n'
    printf '  Install dir : %s\n' "$INSTALL_DIR"
    printf '  Launcher    : %s\n' "$LAUNCHER"
    printf '  Data dir    : %s\n' "${CURSOR_CP_HOME:-$HOME/cursor-cp}"
    printf '\n'

    case ":$PATH:" in
        *":$BIN_DIR:"*) ;;
        *) warn "$BIN_DIR is not on your PATH. Add this to your shell profile:
    export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
    esac

    cat <<EOF
Next steps:
  cursor-cp                  # start the server (http://localhost:8080)
  cursor-cp service install  # optional: run as a background user service
  cursor-cp --help           # all commands

EOF
}

# --- Main -------------------------------------------------------------------

main() {
    printf '%sCursor Control Plane installer%s\n\n' "$BLUE" "$NC"
    check_prerequisites
    clone_or_update
    build_app
    resolve_api_key
    write_env
    create_launcher
    print_summary
}

main
