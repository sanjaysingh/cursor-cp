/**
 * Register HTTP and WebSocket API routes under /api
 */

import type { FastifyInstance } from 'fastify';
import type { EventBus } from '../core/events.js';
import type { SessionManager } from '../core/session-manager.js';
import type { AgentService } from '../core/agent-service.js';
import type { AppConfig } from '../models/types.js';
import type { WebChannel } from '../channels/web-channel.js';
import { registerRoutes } from './routes.js';
import { registerWebSocket } from './websocket.js';

export const API_PREFIX = '/api';

interface RegisterApiOptions {
  eventBus: EventBus;
  sessionManager: SessionManager;
  agentService: AgentService;
  webChannel?: WebChannel;
  config: AppConfig;
}

export async function registerApi(
  app: FastifyInstance,
  options: RegisterApiOptions
): Promise<void> {
  await app.register(async (api) => {
    registerWebSocket(api, options.eventBus);
    await registerRoutes(api, {
      sessionManager: options.sessionManager,
      agentService: options.agentService,
      webChannel: options.webChannel,
      config: options.config,
    });
  }, { prefix: API_PREFIX });
}
