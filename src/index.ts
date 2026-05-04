/**
 * Cursor Control Plane - Entry Point
 * TypeScript + Cursor SDK Edition
 */

import 'dotenv/config';
import fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import staticFiles from '@fastify/static';
import { resolve, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

import { loadConfig } from './config/loader.js';
import { getDatabase } from './db/connection.js';
import {
  SessionRepository,
  MessageRepository,
  ParticipantRepository,
  SettingsRepository,
} from './db/repositories.js';
import { AgentService } from './core/agent-service.js';
import { SessionManager } from './core/session-manager.js';
import { EventBus } from './core/events.js';
import { WebChannel } from './channels/web-channel.js';
import { TelegramChannel } from './channels/telegram-channel.js';
import { ChannelRegistryImpl } from './channels/registry.js';
import { registerRoutes } from './api/routes.js';
import { registerWebSocket } from './api/websocket.js';
import { ensureSetup } from './cli/setup-wizard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DATA_DIR = resolve(homedir(), '.config', 'cursor-cp');

async function main() {
  // Ensure setup wizard has been run
  await ensureSetup(DATA_DIR);

  // Load configuration
  const { config, env } = loadConfig();

  // Validate required config
  if (!env.cursorApiKey) {
    console.error('Error: CURSOR_API_KEY is required');
    console.error('Run: npm run setup');
    console.error('Or set CURSOR_API_KEY environment variable');
    process.exit(1);
  }

  // Initialize database
  const db = getDatabase();

  // Create repositories
  const repositories = {
    sessions: new SessionRepository(db.db),
    messages: new MessageRepository(db.db),
    participants: new ParticipantRepository(db.db),
    settings: new SettingsRepository(db.db),
  };

  // Initialize event bus
  const eventBus = new EventBus();

  // Initialize agent service with Cursor SDK
  const agentService = new AgentService({
    apiKey: env.cursorApiKey,
    defaultModel: config.sdk.defaultModel,
  });

  // Initialize channels
  const channelRegistry = new ChannelRegistryImpl();

  // Web channel (always enabled if configured)
  if (config.channels.web.enabled) {
    const webChannel = new WebChannel(eventBus);
    channelRegistry.register(webChannel);
  }

  // Telegram channel (if enabled and configured)
  if (config.channels.telegram.enabled && env.telegramBotToken) {
    const telegramChannel = new TelegramChannel(
      env.telegramBotToken,
      sessionManager,
      env.telegramAllowedUserIds,
      eventBus
    );
    channelRegistry.register(telegramChannel);
  }

  // Initialize session manager
  const sessionManager = new SessionManager({
    repositories,
    agentService,
    eventBus,
    maxSessions: config.sdk.maxSessions,
    defaultModel: config.sdk.defaultModel,
  });

  // Create Fastify app
  const app = fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
  });

  // Register plugins
  await app.register(cors, {
    origin: true,
    credentials: true,
  });

  await app.register(websocket);

  // Static files (dashboard UI)
  await app.register(staticFiles, {
    root: resolve(__dirname, '../static'),
    prefix: '/',
  });

  // Register WebSocket
  registerWebSocket(app, eventBus);

  // Register API routes
  await registerRoutes(app, {
    sessionManager,
    agentService,
    webChannel,
    config,
  });

  // Start channels
  await channelRegistry.startAll();

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received. Shutting down...`);

    // Close all sessions
    await sessionManager.closeAllSessions();

    // Stop channels
    await channelRegistry.stopAll();

    // Close database
    db.close();

    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Start server
  try {
    await app.listen({
      host: config.server.host,
      port: config.server.port,
    });

    console.log(`
╔══════════════════════════════════════════════════════════╗
║         Cursor Control Plane - SDK Edition               ║
╠══════════════════════════════════════════════════════════╣
║  Server: http://${config.server.host}:${config.server.port}                          ║
║  Workspace: ${config.workspaceRoot}              ║
║  Max Sessions: ${config.sdk.maxSessions}                                          ║
╚══════════════════════════════════════════════════════════╝
    `);
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

main();
