# Cursor Control Plane

A modern TypeScript-based control plane for managing Cursor agent sessions using the official `@cursor/sdk`.

[![CI](https://github.com/sanjaysingh/cursor-cp/actions/workflows/ci.yml/badge.svg)](https://github.com/sanjaysingh/cursor-cp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Installation](#installation)
- [Development](#development)
- [Configuration](#configuration)
- [API Documentation](#api-documentation)
- [Testing](#testing)
- [Contributing](#contributing)
- [License](#license)

## Overview

Cursor Control Plane provides a web-based interface and API for managing persistent Cursor agent sessions. It bridges the gap between the Cursor IDE and automated agent workflows.

### Key Features

- **Web Dashboard**: Real-time chat interface with WebSocket streaming
- **Persistent Sessions**: SQLite-backed session and message storage
- **Multi-Repository Support**: Work across multiple code repositories
- **GitHub Integration**: Clone and manage repositories directly
- **Model Selection**: Choose from available Cursor models
- **REST API**: Full programmatic access to all features

## Architecture

```mermaid
flowchart TB
    subgraph Client
        Browser[Browser Dashboard]
    end

    subgraph Server
        Fastify[Fastify Server]
        API[REST API]
        WS[WebSocket Handler]

        subgraph Core
            SM[SessionManager]
            AS[AgentService]
            EB[EventBus]
            Channels[Channels]
        end

        subgraph Data
            Repos[Repositories]
            SQLite[(SQLite DB)]
        end
    end

    subgraph External
        Cursor[Cursor Agent]
        GitHub[GitHub API]
    end

    Browser -->|HTTP/WebSocket| Fastify
    Fastify --> API
    Fastify --> WS
    API --> SM
    SM --> AS
    SM --> Repos
    AS -->|@cursor/sdk| Cursor
    Repos --> SQLite
    EB -.->|Events| WS
    SM -->|Messages| Channels
```

### Module Structure

```
src/
├── api/              # HTTP & WebSocket routes
├── channels/         # Communication adapters (Web, Telegram)
├── config/           # Configuration loading (YAML + env)
├── core/             # Business logic (AgentService, SessionManager, EventBus)
├── db/               # Database layer (SQLite + repositories)
├── models/           # TypeScript types and Zod schemas
├── mocks/            # SDK mock for development
└── index.ts          # Application entry point
```

### Data Flow

1. **Session Creation**: Client → API → SessionManager → AgentService (creates SDK agent)
2. **Message Flow**: User → SessionManager → AgentService → Cursor SDK → Streaming response
3. **Real-time Updates**: AgentService → EventBus → WebSocket → Client

## Quick Start

### Prerequisites

- Node.js 20+ (22 recommended)
- Cursor API Key ([Get one here](https://cursor.com/dashboard/cloud-agents))
- GitHub CLI (`gh`) - optional but recommended for repo operations

### One-Line Install (macOS/Linux)

```bash
curl -fsSL https://raw.githubusercontent.com/sanjaysingh/cursor-cp/main/install.sh | bash
```

### Manual Install

```bash
# Clone repository
git clone https://github.com/sanjaysingh/cursor-cp.git
cd cursor-cp

# Install dependencies
npm install

# Setup environment
cp .env.example .env
# Edit .env and add your CURSOR_API_KEY

# Start development server
npm run dev
```

Then open http://localhost:8080

## Installation

### System Requirements

| Requirement | Minimum | Recommended |
|-------------|---------|-------------|
| Node.js | 20.x | 22.x |
| RAM | 512MB | 1GB+ |
| Disk | 100MB | 1GB+ (for repos) |
| OS | Linux, macOS | Latest stable |

### Install Script Options

```bash
# Default install (interactive)
bash install.sh

# Silent install (for CI/automation)
export CURSOR_API_KEY="your-key-here"
export INSTALL_DIR="/opt/cursor-cp"
bash install.sh --silent

# Install specific version
bash install.sh --version v0.1.0

# Upgrade existing installation
bash install.sh --upgrade
```

### Post-Installation

After installation, the script will:

1. Create `~/cursor-cp-ws-root/` for repositories
2. Setup `~/.config/cursor-cp/` for config and data
3. Create a systemd service (Linux) or launchd plist (macOS)
4. Start the service

### Service Management

```bash
# Linux (systemd)
sudo systemctl start cursor-cp
sudo systemctl stop cursor-cp
sudo systemctl status cursor-cp

# macOS (launchd)
launchctl start com.cursor.cp
launchctl stop com.cursor.cp
launchctl list | grep cursor-cp
```

## Development

### Setup

```bash
# Clone and install
git clone https://github.com/sanjaysingh/cursor-cp.git
cd cursor-cp
npm install

# Create local environment
cp .env.example .env.local
# Edit .env.local with your settings

# Run database migrations (if any)
npm run db:migrate
```

### Development Commands

```bash
# Start with hot reload
npm run dev

# Type check
npx tsc --noEmit

# Run tests
npm test
npm run test:watch      # Watch mode

# Lint code
npm run lint

# Build for production
npm run build

# Start production build
npm start
```

### Project Structure

```
cursor-cp/
├── src/
│   ├── api/           # Fastify routes and WebSocket
│   ├── channels/      # Communication abstractions
│   ├── config/        # Configuration loader
│   ├── core/          # Core business logic
│   ├── db/            # Database access layer
│   ├── models/        # Domain models
│   └── index.ts       # Entry point
├── static/            # Web dashboard (Alpine.js)
├── tests/             # E2E tests
├── scripts/           # Utility scripts
└── config.yaml        # Configuration file
```

### Adding Features

1. **New API Endpoint**: Add to `src/api/routes.ts`
2. **New Channel**: Implement `Channel` interface in `src/channels/`
3. **Database Changes**: Modify schema in `src/db/connection.ts`, add migration
4. **Events**: Use `EventBus` for real-time communication

## Configuration

### Environment Variables

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `CURSOR_API_KEY` | Cursor API key | **Yes** | - |
| `WORKSPACE_ROOT` | Directory for repositories | No | `~/cursor-cp-ws-root` |
| `PORT` | HTTP server port | No | `8080` |
| `HOST` | HTTP server host | No | `0.0.0.0` |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token | No | - |
| `TELEGRAM_ALLOWED_USER_IDS` | Comma-separated user IDs | No | - |
| `LOG_LEVEL` | Logging level | No | `info` |

### Config File (`config.yaml`)

```yaml
# Repositories to show in dropdown
repos:
  - name: my-project
    path: /path/to/project
    description: My awesome project

# Override default workspace location
workspace_root: /custom/workspace

# Feature toggles
channels:
  telegram:
    enabled: false
  web:
    enabled: true

# Server settings
server:
  host: 0.0.0.0
  port: 8080

# SDK settings
sdk:
  default_model: "composer-2"
  max_sessions: 5
```

### Priority Order

Configuration values are resolved in this priority (highest first):

1. Environment variables
2. `config.yaml` file
3. Default values

## API Documentation

### REST Endpoints

#### Health & Config

```http
GET /api/health
# Response: { "status": "ok", "version": "0.1.0" }

GET /api/dashboard-config
# Response: { "web_channel_key": "web:default", "workspace_root": "...", "default_model": "..." }
```

#### Sessions

```http
# List sessions
GET /api/sessions?include_closed=false

# Create session
POST /api/sessions
Content-Type: application/json
{
  "repoPath": "/path/to/repo",
  "title": "My Session",
  "model": "composer-2"
}

# Get session details
GET /api/sessions/:sessionId

# Send message
POST /api/sessions/:sessionId/message
Content-Type: application/json
{ "text": "Hello, agent!" }

# Close session
POST /api/sessions/:sessionId/close

# Get messages
GET /api/sessions/:sessionId/messages
```

#### Repositories

```http
GET /api/workspaces           # List local workspaces
GET /api/github/repos         # List GitHub repos (requires gh CLI)
POST /api/github/clone        # Clone a repo
GET /api/repo-picker           # Combined local + GitHub list
```

#### Models

```http
GET /api/models              # List available models
PUT /api/settings/default-model
Content-Type: application/json
{ "model": "composer-2" }
```

### WebSocket

Connect to `/api/ws` for real-time updates.

**Outgoing Messages:**
```json
{ "type": "ping" }
```

**Incoming Events:**
```json
// Agent streaming
{ "type": "agent_stream", "session_id": "...", "text": "..." }

// Session updated
{ "type": "session_updated", "session": { ... } }

// Question from agent
{ "type": "question", "session_id": "...", "question": "...", "options": [...] }

// Keep alive
{ "type": "pong" }
```

## Testing

### Unit Tests

```bash
# Run all tests
npm test

# Watch mode during development
npm run test:watch

# With coverage
npx vitest run --coverage
```

### E2E Tests

```bash
# Build first
npm run build

# Start server and run e2e tests
npm run test:e2e
```

### Test Structure

- `src/**/*.test.ts` - Unit tests alongside source files
- `tests/` - Integration and E2E tests

### Writing Tests

```typescript
import { describe, it, expect } from 'vitest';
import { SessionManager } from './session-manager.js';

describe('SessionManager', () => {
  it('should create a session', async () => {
    const manager = createTestManager();
    const session = await manager.createSession('web', 'key', '/repo', 'Test');
    expect(session.status).toBe('open');
  });
});
```

## Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

### Development Workflow

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make changes with tests
4. Run the full test suite (`npm test`)
5. Commit (`git commit -m 'Add amazing feature'`)
6. Push (`git push origin feature/amazing-feature`)
7. Open a Pull Request

### Code Style

- TypeScript strict mode enabled
- ESLint for code quality
- Prettier for formatting (optional)
- Conventional commits preferred

### CI Requirements

All PRs must pass:
- ✅ Type check (`tsc --noEmit`)
- ✅ Lint (`eslint`)
- ✅ Unit tests (`vitest`)
- ✅ Build (`tsc`)
- ✅ E2E smoke test

## Troubleshooting

### Common Issues

**"CURSOR_API_KEY is required"**
```bash
export CURSOR_API_KEY="your-key-here"
# Or add to .env file
```

**"Cannot find module '@cursor/sdk'"**
Run `npm install` to install dependencies including `@cursor/sdk`.

**Port already in use**
```bash
PORT=8081 npm run dev
```

### Debug Mode

```bash
LOG_LEVEL=debug npm run dev
```

## License

[MIT](LICENSE) © Sanjay Singh

---

Made with TypeScript and the Cursor SDK
