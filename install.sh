#!/bin/bash
#
# Cursor Control Plane Installation Script
# Supports macOS and Linux
#

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
REPO_URL="https://github.com/sanjaysingh/cursor-cp"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.cursor-cp}"
WORKSPACE_DIR="${WORKSPACE_DIR:-$HOME/cursor-cp-workspace}"
DATA_DIR="${DATA_DIR:-$HOME/.config/cursor-cp}"
VERSION="${VERSION:-latest}"
SILENT=false
UPGRADE=false

# Logging functions
log() {
    if [ "$SILENT" = false ]; then
        echo -e "${BLUE}[cursor-cp]${NC} $1"
    fi
}

warn() {
    if [ "$SILENT" = false ]; then
        echo -e "${YELLOW}[warning]${NC} $1"
    fi
}

error() {
    echo -e "${RED}[error]${NC} $1" >&2
}

success() {
    if [ "$SILENT" = false ]; then
        echo -e "${GREEN}[success]${NC} $1"
    fi
}

# Parse arguments
parse_args() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            --silent)
                SILENT=true
                shift
                ;;
            --version)
                VERSION="$2"
                shift 2
                ;;
            --upgrade)
                UPGRADE=true
                shift
                ;;
            --help|-h)
                cat << 'EOF'
Cursor Control Plane Installer

Usage: install.sh [OPTIONS]

Options:
    --silent          Non-interactive mode (requires CURSOR_API_KEY env var)
    --version TAG     Install specific version (default: latest)
    --upgrade         Upgrade existing installation
    --help, -h        Show this help message

Environment Variables:
    CURSOR_API_KEY    Required API key (or will prompt in interactive mode)
    INSTALL_DIR       Installation directory (default: ~/.cursor-cp)
    WORKSPACE_DIR     Workspace for repositories (default: ~/cursor-cp-workspace)
    DATA_DIR          Data/config directory (default: ~/.config/cursor-cp)

Examples:
    # Interactive install
    bash install.sh

    # Silent install
    export CURSOR_API_KEY="your-key"
    bash install.sh --silent

    # Upgrade existing
    bash install.sh --upgrade

    # Specific version
    bash install.sh --version v0.1.0

EOF
                exit 0
                ;;
            *)
                error "Unknown option: $1"
                exit 1
                ;;
        esac
    done
}

# Check prerequisites
check_prerequisites() {
    log "Checking prerequisites..."

    # Check OS
    case "$(uname -s)" in
        Linux*)     OS=Linux;;
        Darwin*)    OS=Mac;;
        *)          error "Unsupported OS: $(uname -s)"; exit 1;;
    esac

    # Check Node.js
    if ! command -v node &> /dev/null; then
        error "Node.js is not installed. Please install Node.js 20+ and try again."
        error "Visit: https://nodejs.org/"
        exit 1
    fi

    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -lt 20 ]; then
        error "Node.js 20+ is required. Found: $(node -v)"
        exit 1
    fi

    log "Found Node.js $(node -v)"

    # Check npm
    if ! command -v npm &> /dev/null; then
        error "npm is not installed"
        exit 1
    fi

    # Check git
    if ! command -v git &> /dev/null; then
        warn "git is not installed. Repository cloning will not be available."
    fi

    # Check GitHub CLI
    if ! command -v gh &> /dev/null; then
        warn "GitHub CLI (gh) is not installed. GitHub integration will be limited."
        if [ "$SILENT" = false ]; then
            read -p "Install gh CLI? (y/N) " -n 1 -r
            echo
            if [[ $REPLY =~ ^[Yy]$ ]]; then
                install_gh_cli
            fi
        fi
    fi
}

# Install GitHub CLI
install_gh_cli() {
    case "$OS" in
        Mac)
            if command -v brew &> /dev/null; then
                brew install gh
            else
                warn "Homebrew not found. Please install gh manually:"
                warn "https://cli.github.com/"
            fi
            ;;
        Linux)
            if command -v apt-get &> /dev/null; then
                curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
                sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
                echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
                sudo apt-get update
                sudo apt-get install -y gh
            elif command -v yum &> /dev/null; then
                sudo yum install -y gh
            else
                warn "Please install gh manually: https://cli.github.com/"
            fi
            ;;
    esac
}

# Get API key
get_api_key() {
    if [ -n "$CURSOR_API_KEY" ]; then
        API_KEY="$CURSOR_API_KEY"
        return
    fi

    if [ "$SILENT" = true ]; then
        error "CURSOR_API_KEY environment variable is required in silent mode"
        exit 1
    fi

    echo
    echo "To use Cursor Control Plane, you need a Cursor API key."
    echo "Get one at: https://cursor.com/dashboard/cloud-agents"
    echo

    while true; do
        read -s -p "Enter your Cursor API key: " API_KEY
        echo

        if [ -z "$API_KEY" ]; then
            error "API key cannot be empty"
            continue
        fi

        if [[ "$API_KEY" == cursor_* ]]; then
            break
        else
            warn "API key should start with 'cursor_'"
            read -p "Continue anyway? (y/N) " -n 1 -r
            echo
            if [[ $REPLY =~ ^[Yy]$ ]]; then
                break
            fi
        fi
    done
}

# Download/install
download_install() {
    log "Installing Cursor Control Plane..."

    # Create directories
    mkdir -p "$INSTALL_DIR"
    mkdir -p "$WORKSPACE_DIR"
    mkdir -p "$DATA_DIR"

    if [ "$UPGRADE" = true ] && [ -d "$INSTALL_DIR/.git" ]; then
        log "Upgrading existing installation..."
        cd "$INSTALL_DIR"
        git fetch origin
        if [ "$VERSION" = "latest" ]; then
            git checkout main
            git pull origin main
        else
            git checkout "$VERSION"
        fi
    else
        log "Cloning repository..."
        if [ -d "$INSTALL_DIR/.git" ]; then
            rm -rf "$INSTALL_DIR"
        fi
        git clone --depth 1 "$REPO_URL.git" "$INSTALL_DIR"
        cd "$INSTALL_DIR"

        if [ "$VERSION" != "latest" ]; then
            git fetch --tags
            git checkout "$VERSION"
        fi
    fi

    log "Installing dependencies..."
    cd "$INSTALL_DIR"
    npm ci

    log "Building application..."
    npm run build

    success "Installation complete!"
}

# Create environment file
setup_environment() {
    log "Setting up environment..."

    cat > "$DATA_DIR/.env" << EOF
# Cursor Control Plane Environment Configuration
# Generated by install.sh on $(date)

# Required: Cursor API Key
# Get from: https://cursor.com/dashboard/cloud-agents
CURSOR_API_KEY=$API_KEY

# Workspace directory for repositories
WORKSPACE_ROOT=$WORKSPACE_DIR

# Server configuration
PORT=8080
HOST=0.0.0.0

# Data directory
DATA_DIR=$DATA_DIR

# Logging
LOG_LEVEL=info
EOF

    # Create config.yaml
    cat > "$DATA_DIR/config.yaml" << EOF
repos: []

workspace_root: "$WORKSPACE_DIR"

channels:
  telegram:
    enabled: false
  web:
    enabled: true

server:
  host: 0.0.0.0
  port: 8080

sdk:
  default_model: "composer-2.5"
  max_sessions: 5
EOF

    # Create symlink for easy access
    mkdir -p "$HOME/.local/bin"
    cat > "$HOME/.local/bin/cursor-cp" << 'EOF'
#!/bin/bash
DATA_DIR="${DATA_DIR:-$HOME/.config/cursor-cp}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.cursor-cp}"
export $(cat "$DATA_DIR/.env" | xargs)
cd "$INSTALL_DIR"
exec node dist/index.js "$@"
EOF
    chmod +x "$HOME/.local/bin/cursor-cp"

    success "Environment configured"
}

# Setup service
setup_service() {
    if [ "$SILENT" = true ]; then
        return
    fi

    case "$OS" in
        Linux)
            if command -v systemctl &> /dev/null; then
                log "Setting up systemd service..."

                cat > /tmp/cursor-cp.service << EOF
[Unit]
Description=Cursor Control Plane
After=network.target

[Service]
Type=simple
User=$USER
Environment=NODE_ENV=production
EnvironmentFile=$DATA_DIR/.env
WorkingDirectory=$INSTALL_DIR
ExecStart=$HOME/.local/bin/cursor-cp
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
                echo
                echo "To install as a system service, run:"
                echo "  sudo mv /tmp/cursor-cp.service /etc/systemd/system/"
                echo "  sudo systemctl daemon-reload"
                echo "  sudo systemctl enable cursor-cp"
                echo "  sudo systemctl start cursor-cp"
                echo
            fi
            ;;
        Mac)
            log "Setting up launchd service..."

            cat > "$HOME/Library/LaunchAgents/com.cursor.cp.plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.cursor.cp</string>
    <key>ProgramArguments</key>
    <array>
        <string>$HOME/.local/bin/cursor-cp</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>NODE_ENV</key>
        <string>production</string>
    </dict>
    <key>WorkingDirectory</key>
    <string>$INSTALL_DIR</string>
    <key>StandardOutPath</key>
    <string>$DATA_DIR/service.log</string>
    <key>StandardErrorPath</key>
    <string>$DATA_DIR/service.error.log</string>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
EOF

            launchctl load "$HOME/Library/LaunchAgents/com.cursor.cp.plist" 2>/dev/null || true
            success "Launchd service configured"
            ;;
    esac
}

# Print final instructions
print_instructions() {
    if [ "$SILENT" = true ]; then
        return
    fi

    echo
    echo "╔══════════════════════════════════════════════════════════╗"
    echo "║     Cursor Control Plane Installation Complete!          ║"
    echo "╠══════════════════════════════════════════════════════════╣"
    echo "║                                                          ║"
    echo "║  Installation Directory: $INSTALL_DIR"
    echo "║  Workspace Directory:    $WORKSPACE_DIR"
    echo "║  Data Directory:         $DATA_DIR"
    echo "║                                                          ║"
    echo "║  Start the server:                                      ║"
    echo "║    cursor-cp                                           ║"
    echo "║    # or                                                ║"
    echo "║    cd $INSTALL_DIR && npm run dev                     ║"
    echo "║                                                          ║"
    echo "║  Open in browser:                                       ║"
    echo "║    http://localhost:8080                               ║"
    echo "║                                                          ║"
    echo "╚══════════════════════════════════════════════════════════╝"
    echo

    # Start the server?
    read -p "Start the server now? (Y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Nn]$ ]]; then
        log "Starting Cursor Control Plane..."
        echo "Press Ctrl+C to stop"
        echo
        cd "$INSTALL_DIR" && exec node dist/index.js
    fi
}

# Main
main() {
    parse_args "$@"

    echo
    echo "Cursor Control Plane Installer"
    echo "=============================="
    echo

    check_prerequisites
    get_api_key
    download_install
    setup_environment
    setup_service
    print_instructions
}

main "$@"
