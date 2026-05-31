/**
 * Cursor Control Plane - Entry Point
 * TypeScript + Cursor SDK Edition
 */

import fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import staticFiles from '@fastify/static';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import { requireCursorApiKey } from './config/env.js';
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
import { registerApi } from './api/register-api.js';
import { logger, getLogFilePath, createFastifyLoggerConfig } from './util/logger.js';
import { ensureProjectDirs, projectHomeDir } from './paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  requireCursorApiKey();

  const { config, env } = loadConfig();

  ensureProjectDirs();

  const logFile = getLogFilePath();
  if (logFile) {
    logger.info({ logFile, projectHome: projectHomeDir() }, 'File logging enabled');
  } else {
    logger.info('File logging disabled');
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

  // Initialize session manager first (needed by channels)
  const sessionManager = new SessionManager({
    repositories,
    agentService,
    eventBus,
    registry: channelRegistry,
    maxSessions: config.sdk.maxSessions,
    defaultModel: config.sdk.defaultModel,
  });

  // Web channel (always enabled if configured)
  let webChannel: WebChannel | undefined;
  if (config.channels.web.enabled) {
    webChannel = new WebChannel(eventBus);
    channelRegistry.register(webChannel);
  }

  // Telegram channel (if enabled and configured)
  if (config.channels.telegram.enabled && env.telegramBotToken) {
    logger.info(
      { allowedUsers: env.telegramAllowedUserIds.size },
      'Registering Telegram channel'
    );
    const telegramChannel = new TelegramChannel(
      env.telegramBotToken,
      sessionManager,
      env.telegramAllowedUserIds,
      config
    );
    channelRegistry.register(telegramChannel);
  } else if (config.channels.telegram.enabled) {
    logger.warn('Telegram enabled in config but TELEGRAM_BOT_TOKEN is not set');
  }

  // Create Fastify app
  const app = fastify({
    logger: createFastifyLoggerConfig(),
  });

  // Register plugins
  await app.register(cors, {
    origin: true,
    credentials: true,
  });

  await app.register(websocket);

  // API routes and WebSocket (must be registered before static files)
  await registerApi(app, {
    eventBus,
    sessionManager,
    agentService,
    webChannel,
    config,
  });

  // Static files (dashboard UI)
  await app.register(staticFiles, {
    root: resolve(__dirname, '../static'),
    prefix: '/',
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown requested');

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

  // Start HTTP server before channels so the web UI works even if Telegram is slow
  try {
    await app.listen({
      host: config.server.host,
      port: config.server.port,
    });

    logger.info(
      {
        host: config.server.host,
        port: config.server.port,
        workspace: config.workspaceRoot,
        maxSessions: config.sdk.maxSessions,
        web: config.channels.web.enabled,
        telegram: config.channels.telegram.enabled && Boolean(env.telegramBotToken),
      },
      'HTTP server listening'
    );

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
    logger.error({ err }, 'Failed to start HTTP server');
    process.exit(1);
  }

  // Start channels after HTTP is up (Telegram polling must not block the web server)
  await channelRegistry.startAll();
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error during startup');
  process.exit(1);
});
