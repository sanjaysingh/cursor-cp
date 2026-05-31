# Cursor Control Plane

A TypeScript control plane for creating and managing [Cursor](https://cursor.com) agent sessions from a web dashboard or a Telegram bot, built on the official [`@cursor/sdk`](https://www.npmjs.com/package/@cursor/sdk).

[![CI](https://github.com/sanjaysingh/cursor-cp/actions/workflows/ci.yml/badge.svg)](https://github.com/sanjaysingh/cursor-cp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

## Table of Contents

- [Overview](#overview)
- [Quick Start](#quick-start)
- [Installation](#installation)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Development](#development)
- [API Reference](#api-reference)
- [Telegram Bot](#telegram-bot)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

## Overview

Cursor Control Plane runs Cursor agent sessions for you and exposes them through a
real-time web dashboard, a REST API, and an optional Telegram bot. Sessions and
their message history are persisted to SQLite, so they survive restarts and can be
resumed automatically.

### Features

- **Web dashboard** — real-time chat UI with WebSocket streaming
- **Telegram bot** — drive agents from chat, with inline buttons for sessions, models, and repos
- **Persistent sessions** — SQLite-backed session, message, and participant storage
- **Multi-repository support** — work across local workspaces and clone GitHub repos via the `gh` CLI
- **Model selection** — choose any model the Cursor SDK exposes, per session or as a default
- **REST API** — full programmatic access to every feature

## Quick Start

### Prerequisites

| Requirement | Minimum | Recommended | Notes |
|-------------|---------|-------------|-------|
| Node.js | 20.x | 22.x | |
| npm | 9.x | latest | Ships with Node.js |
| Cursor API key | — | — | [Get one here](https://cursor.com/dashboard/cloud-agents) |
| Git | any | latest | Required to clone/update |
| GitHub CLI (`gh`) | — | latest | Optional, enables repo browsing/cloning |

### Install (macOS / Linux)

```bash
curl -fsSL https://raw.githubusercontent.com/sanjaysingh/cursor-cp/main/install.sh | bash
```

That's the supported install method. It performs a per-user install (no `sudo`,
everything inside your home directory): it clones the project to
`~/.local/share/cursor-cp`, installs dependencies, builds it, writes your
configuration, and adds a `cursor-cp` launcher to `~/.local/bin`. You'll be prompted
for your Cursor API key.

Then start it:

```bash
cursor-cp        # serve at http://localhost:8080
```

> **Prefer to clone and run from source?** See [Development](#development).

## Installation

### One-line installer

```bash
curl -fsSL https://raw.githubusercontent.com/sanjaysingh/cursor-cp/main/install.sh | bash
```

For a fully non-interactive install (no prompt), set the API key first:

```bash
export CURSOR_API_KEY="cursor_..."
curl -fsSL https://raw.githubusercontent.com/sanjaysingh/cursor-cp/main/install.sh | bash
```

Pass options through the pipe with `bash -s --`:

```bash
# Install a specific tag/branch, or to a custom directory
curl -fsSL https://raw.githubusercontent.com/sanjaysingh/cursor-cp/main/install.sh \
  | bash -s -- --version v0.1.0 --dir "$HOME/apps/cursor-cp"
```

You can also download and run it directly (`bash install.sh [options]`).

| Flag | Environment variable | Default | Description |
|------|----------------------|---------|-------------|
| `--version <ref>` | `CURSOR_CP_VERSION` | `latest` (main) | Git tag/branch to install |
| `--dir <path>` | `CURSOR_CP_INSTALL_DIR` | `~/.local/share/cursor-cp` | Install location |
| `--help` | — | — | Show usage |

**Upgrading:** re-run the same one-liner. The installer detects the existing install,
fetches and checks out the requested version, reinstalls dependencies, and rebuilds.
Your `.env` is preserved.

### After installing

```bash
# Start the server in the foreground
cursor-cp

# Or run it as a per-user background service (systemd --user / launchd)
cursor-cp service install
cursor-cp service status
```

If `~/.local/bin` is not on your `PATH`, the installer prints the line to add to your
shell profile.

### Runtime layout

All runtime data lives under `~/cursor-cp/` (override with `CURSOR_CP_HOME`):

```
~/cursor-cp/
├── ws-root/   cloned repositories / agent working directories
├── logs/      daily JSON logs (cursor-cp-YYYY-MM-DD.log, kept 7 days)
└── data/      SQLite database (cursor-cp.db) and service metadata
```

## Configuration

Configuration is resolved with the following precedence (highest first):

1. Environment variables (and `.env` in the project root)
2. `config.yaml` in the project root
3. Built-in defaults

### Environment variables

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `CURSOR_API_KEY` | Cursor API key | **Yes** | — |
| `PORT` | HTTP server port | No | `8080` |
| `HOST` | HTTP server host | No | `0.0.0.0` |
| `WORKSPACE_ROOT` | Directory for cloned repos / agent workspaces | No | `~/cursor-cp/ws-root` |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token (enables the bot when set and configured) | No | — |
| `TELEGRAM_ALLOWED_USER_IDS` | Comma/space-separated Telegram user IDs allowed to use the bot | No | — |
| `LOG_LEVEL` | Log level (`debug`, `info`, `warn`, `error`) | No | `info` |
| `LOG_FILE` | Base path for daily log files; set to `false` to disable file logging | No | `~/cursor-cp/logs/cursor-cp.log` |
| `CURSOR_CP_HOME` | Root directory for all runtime data | No | `~/cursor-cp` |
| `CURSOR_CP_DB_PATH` | Override the SQLite database path | No | `~/cursor-cp/data/cursor-cp.db` |
| `CONFIG_PATH` | Override the path to `config.yaml` | No | `<project>/config.yaml` |

Console logging is always enabled; daily file logging is on by default.

### Config file (`config.yaml`)

```yaml
# Repositories pinned to the top of the picker
repos:
  - name: my-project
    path: /path/to/project
    description: My awesome project

# Override the default workspace location (env WORKSPACE_ROOT takes precedence)
# workspace_root: /custom/workspace

# Channel toggles
channels:
  telegram:
    enabled: false   # also requires TELEGRAM_BOT_TOKEN
  web:
    enabled: true

# Server settings (env PORT/HOST take precedence)
server:
  host: 0.0.0.0
  port: 8080

# Cursor SDK settings
sdk:
  default_model: "composer-2.5"   # empty lets the SDK choose
  max_sessions: 5                 # maximum concurrent sessions
```

## Architecture

```mermaid
flowchart TB
    subgraph Clients
        Browser[Web Dashboard]
        TG[Telegram]
    end

    subgraph Server[Fastify Server]
        API[REST API]
        WS[WebSocket]
        subgraph Core
            SM[SessionManager]
            AS[AgentService]
            EB[EventBus]
            CH[Channels]
        end
        subgraph Data
            Repos[Repositories]
            SQLite[(SQLite)]
        end
    end

    subgraph External
        Cursor[Cursor Agent]
        GitHub[GitHub CLI]
    end

    Browser -->|HTTP / WebSocket| API
    TG -->|Bot API| CH
    API --> SM
    SM --> AS
    SM --> Repos
    AS -->|@cursor/sdk| Cursor
    Repos --> SQLite
    EB -.->|events| WS
    SM --> CH
```

### Data flow

1. **Session creation** — Client → API → `SessionManager` → `AgentService` (creates an SDK agent).
2. **Messages** — User → `SessionManager` → `AgentService` → Cursor SDK → streamed response.
3. **Real-time updates** — `AgentService` → `EventBus` → WebSocket → web clients; non-web channels receive the full reply when the run completes.

### Module structure

```
src/
├── api/        # Fastify routes + WebSocket registration
├── channels/   # Communication adapters (web, Telegram) + registry
├── config/     # Environment and YAML configuration loading
├── core/       # Business logic: AgentService, SessionManager, EventBus, repo picker
├── db/         # SQLite connection and repositories
├── format/     # Markdown → Telegram formatting
├── models/     # TypeScript types and Zod schemas
├── service/    # systemd/launchd service control
├── util/       # Logger and daily log rotation
├── cli/        # CLI entry point (serve, config, service)
├── paths.ts    # Runtime path resolution
└── index.ts    # Application entry point
static/         # Web dashboard (Alpine.js + Tailwind via CDN)
```

## Development

```bash
git clone https://github.com/sanjaysingh/cursor-cp.git
cd cursor-cp
npm install
cp .env.example .env   # then set CURSOR_API_KEY
```

### Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start the server with hot reload (`tsx watch`) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled server (`node dist/index.js`) |
| `npm test` | Run the test suite (Vitest) |
| `npm run test:watch` | Run tests in watch mode |
| `npm run lint` | Lint with ESLint |
| `npx tsc --noEmit` | Type-check without emitting |

The database schema is created and migrated automatically on first connection — there
is no separate migration step.

## API Reference

All endpoints are served under the `/api` prefix.

### Health & config

```http
GET /api/health
# → { "status": "ok", "version": "0.1.0" }

GET /api/dashboard-config
# → { "web_channel_key": "web:default", "workspace_root": "...", "default_model": "...", "max_sessions": 5 }
```

### Sessions

```http
GET  /api/sessions?include_closed=false      # List sessions
POST /api/sessions                           # Create a session
GET  /api/sessions/:id                        # Get a session
GET  /api/sessions/:id/messages               # Get message history
POST /api/sessions/:id/message                # Send a message
POST /api/sessions/:id/join                   # Join an existing session
POST /api/sessions/:id/answer                 # Answer a pending agent question
POST /api/sessions/:id/close                  # Close and delete a session
POST /api/sessions/close-all                  # Close and delete all sessions
```

Create a session:

```http
POST /api/sessions
Content-Type: application/json

{
  "repoPath": "/path/to/repo",   // optional; defaults to the workspace root
  "title": "My Session",          // optional
  "model": "composer-2.5"         // optional; null/omitted uses the default
}
```

### Repositories & models

```http
GET  /api/workspaces                  # Local workspace folders
GET  /api/github/repos?limit=40       # GitHub repos (requires gh CLI)
POST /api/github/clone                # Clone a repo into the workspace
GET  /api/repo-picker?gh_limit=80     # Combined, de-duplicated local + GitHub list
GET  /api/models                      # Available models
PUT  /api/settings/default-model      # Set the default model
```

### WebSocket

Connect to `/api/ws` for real-time updates. Send `{ "type": "ping" }` to receive a
`{ "type": "pong" }` keep-alive. Server events include `hello`, `session_updated`,
`session_removed`, `sessions_purged`, `agent_stream`, `channel_message`, and `question`.

## Telegram Bot

Set `TELEGRAM_BOT_TOKEN`, list the allowed user IDs in `TELEGRAM_ALLOWED_USER_IDS`,
and enable the channel in `config.yaml` (`channels.telegram.enabled: true`). The bot
exposes the following commands:

| Command | Description |
|---------|-------------|
| `/start` | Show help |
| `/sessions` | List sessions and connect |
| `/models` | List models and set the default |
| `/current` | Show the current session |
| `/close` | Close the current session |
| `/closeall` | Close all sessions |
| `/repos` | Browse and clone GitHub repos (`gh`) |
| `/workspaces` | Browse local workspace folders |

Any other text is sent to the active session. Only users listed in
`TELEGRAM_ALLOWED_USER_IDS` are allowed to interact with the bot.

## Troubleshooting

**`CURSOR_API_KEY is required`** — Set the key in your environment or `.env`:

```bash
export CURSOR_API_KEY="cursor_..."
```

**Port already in use** — Start on a different port:

```bash
PORT=8081 npm run dev
```

**GitHub features unavailable** — Install and authenticate the GitHub CLI:

```bash
gh auth login
```

**Verbose logging** — Run with debug logs:

```bash
LOG_LEVEL=debug npm run dev
```

## Contributing

Contributions are welcome! Please read the [Contributing Guide](CONTRIBUTING.md) before
opening a pull request. All pull requests must pass lint, type check, tests, and build
in CI.

## License

[MIT](LICENSE) © Sanjay Singh
