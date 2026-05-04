/**
 * Fastify API routes
 */

import type { FastifyInstance } from 'fastify';
import type { SessionManager } from '../core/session-manager.js';
import type { AgentService } from '../core/agent-service.js';
import type { AppConfig } from '../models/types.js';
import type { WebChannel } from '../channels/web-channel.js';
import {
  CreateSessionRequest,
  SendSessionMessageRequest,
  AnswerQuestionRequest,
  CloneRepoRequest,
  UpdateDefaultModelRequest,
  CreateRunRequest,
} from '../models/schemas.js';
import { buildRepoPicker } from '../core/repo-picker.js';
import { join } from 'path';
import { existsSync } from 'fs';
import { mkdir } from 'fs/promises';

const WEB_CHANNEL_KEY = 'web:default';

interface RoutesOptions {
  sessionManager: SessionManager;
  agentService: AgentService;
  webChannel: WebChannel;
  config: AppConfig;
}

export async function registerRoutes(
  fastify: FastifyInstance,
  options: RoutesOptions
): Promise<void> {
  const { sessionManager, agentService, webChannel, config } = options;

  // Health check
  fastify.get('/health', async () => ({
    status: 'ok',
    version: '0.1.0',
  }));

  // Dashboard config
  fastify.get('/dashboard-config', async () => ({
    web_channel_key: WEB_CHANNEL_KEY,
    workspace_root: config.workspaceRoot,
    default_model: sessionManager.getDefaultModel(),
  }));

  // List available models
  fastify.get('/models', async () => {
    const models = await agentService.listAvailableModels();
    return {
      models,
      error: null,
      source: 'sdk',
    };
  });

  // Update default model
  fastify.put('/settings/default-model', async (request) => {
    const body = UpdateDefaultModelRequest.parse(request.body);
    sessionManager.setDefaultModel(body.model ?? null);
    return {
      ok: true,
      default_model: sessionManager.getDefaultModel(),
    };
  });

  // List workspaces
  fastify.get('/workspaces', async () => {
    const items: Array<{ name: string; path: string; isGitRepo: boolean }> = [];

    try {
      const entries = await readdir(config.workspaceRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          const path = join(config.workspaceRoot, entry.name);
          const isGitRepo = existsSync(join(path, '.git'));
          items.push({ name: entry.name, path, isGitRepo });
        }
      }
    } catch {
      // Directory might not exist yet
    }

    return { items };
  });

  // List GitHub repos (requires gh CLI)
  fastify.get('/github/repos', async (request) => {
    const limit = Math.min(100, Math.max(1, parseInt((request.query as { limit?: string }).limit ?? '40', 10)));

    try {
      const { execa } = await import('execa');
      const { stdout } = await execa('gh', ['repo', 'list', '--limit', String(limit), '--json', 'nameWithOwner,description']);
      const repos = JSON.parse(stdout) as Array<{ nameWithOwner: string; description: string }>;
      return { repos, error: '' };
    } catch (err) {
      return {
        repos: [],
        error: err instanceof Error ? err.message : 'GitHub CLI not available or not authenticated',
      };
    }
  });

  // Clone GitHub repo
  fastify.post('/github/clone', async (request, reply) => {
    const body = CloneRepoRequest.parse(request.body);

    try {
      const { execa } = await import('execa');

      // Create workspace if needed
      await mkdir(config.workspaceRoot, { recursive: true });

      const repoName = body.nameWithOwner.split('/')[1];
      const targetPath = join(config.workspaceRoot, repoName);

      // Check if already exists
      if (existsSync(targetPath)) {
        return reply.status(400).send({ error: `Directory already exists: ${targetPath}` });
      }

      await execa('gh', ['repo', 'clone', body.nameWithOwner], { cwd: config.workspaceRoot });

      return { path: targetPath };
    } catch (err) {
      return reply.status(400).send({
        error: err instanceof Error ? err.message : 'Failed to clone repository',
      });
    }
  });

  // Repo picker (local + GitHub) with advanced deduplication
  fastify.get('/repo-picker', async (request) => {
    const ghLimit = Math.min(100, Math.max(1, parseInt((request.query as { gh_limit?: string }).gh_limit ?? '80', 10)));

    const result = await buildRepoPicker(config, ghLimit);

    // Transform to API format
    const items = result.items.map((item) => ({
      id: item.id,
      type: item.type,
      name: item.type === 'github' ? (item.nameWithOwner || item.label) : item.label.replace('local-', ''),
      path: item.path,
      description: item.description,
      nameWithOwner: item.nameWithOwner || undefined,
      isCloned: item.isCloned,
    }));

    return { items, error: result.error };
  });

  // --- Session Routes ---

  // List sessions
  fastify.get('/sessions', async (request) => {
    const includeClosed = (request.query as { include_closed?: string }).include_closed === 'true';
    const sessions = sessionManager.listAllSessions(includeClosed);
    return sessions.map(s => toPublicSession(s));
  });

  // Create session
  fastify.post('/sessions', async (request, reply) => {
    const body = CreateSessionRequest.parse(request.body);

    if (body.repoPath && !existsSync(body.repoPath)) {
      return reply.status(400).send({ error: 'Not a valid directory' });
    }

    try {
      const session = await sessionManager.createSession(
        'web',
        WEB_CHANNEL_KEY,
        body.repoPath ?? '',
        body.title,
        body.model
      );
      return toPublicSession(session);
    } catch (err) {
      if (err instanceof Error && err.name === 'SessionLimitError') {
        return reply.status(400).send({ error: err.message });
      }
      throw err;
    }
  });

  // Close all sessions
  fastify.post('/sessions/close-all', async () => {
    const count = await sessionManager.closeAllSessions();
    return { ok: true, deleted: count };
  });

  // Get session
  fastify.get('/sessions/:sessionId', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const session = sessionManager.getSession(sessionId);
    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }
    return toPublicSession(session);
  });

  // Get session messages
  fastify.get('/sessions/:sessionId/messages', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const session = sessionManager.getSession(sessionId);
    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }
    return sessionManager.getSessionMessages(sessionId);
  });

  // Join session
  fastify.post('/sessions/:sessionId/join', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const session = await sessionManager.joinSession(sessionId, 'web', WEB_CHANNEL_KEY);
    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }
    return toPublicSession(session);
  });

  // Send message to session
  fastify.post('/sessions/:sessionId/message', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const body = SendSessionMessageRequest.parse(request.body);

    try {
      const session = await sessionManager.sendSessionMessage(
        sessionId,
        body.text,
        'web',
        WEB_CHANNEL_KEY
      );
      return toPublicSession(session);
    } catch (err) {
      if ((err as Error).message?.includes('not found')) {
        return reply.status(404).send({ error: 'Session not found' });
      }
      throw err;
    }
  });

  // Close session
  fastify.post('/sessions/:sessionId/close', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const ok = await sessionManager.closeSession(sessionId);
    if (!ok) {
      return reply.status(404).send({ error: 'Session not found' });
    }
    return { ok: true, session_id: sessionId };
  });

  // Answer question
  fastify.post('/sessions/:sessionId/answer', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const body = AnswerQuestionRequest.parse(request.body);

    const ok = webChannel.submitAnswer(sessionId, body.answer, WEB_CHANNEL_KEY);
    if (!ok) {
      return reply.status(404).send({ error: 'No pending question for this session' });
    }
    return { ok: true };
  });

  // --- API Compatibility Aliases ---

  fastify.get('/runs', async (request) => {
    const includeCompleted = (request.query as { include_completed?: string }).include_completed !== 'false';
    const sessions = sessionManager.listAllSessions(includeCompleted);
    return sessions.map(s => toPublicSession(s));
  });

  fastify.post('/runs', async (request, reply) => {
    const body = CreateRunRequest.parse(request.body);

    const session = await sessionManager.submitIncoming({
      conversationId: body.conversationId,
      channel: 'web',
      text: body.prompt,
      repoPath: body.repoPath,
    });

    if (!session) {
      return reply.status(400).send({ error: 'Could not start (invalid repo or session limit)' });
    }

    return toPublicSession(session);
  });

  fastify.post('/runs/:sessionId/stop', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const ok = await sessionManager.closeSession(sessionId);
    if (!ok) {
      return reply.status(404).send({ error: 'Session not found' });
    }
    return { ok: true, session_id: sessionId };
  });

  fastify.post('/runs/:sessionId/answer', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const body = AnswerQuestionRequest.parse(request.body);

    const ok = webChannel.submitAnswer(sessionId, body.answer, WEB_CHANNEL_KEY);
    if (!ok) {
      return reply.status(404).send({ error: 'No pending question' });
    }
    return { ok: true };
  });
}

function toPublicSession(session: {
  id: string;
  channel: string;
  channelKey: string;
  repoPath: string;
  repoName: string;
  title: string;
  status: string;
  activity: string;
  model: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  errorMessage: string | null;
  outputPreview: string;
}) {
  return {
    id: session.id,
    channel: session.channel,
    channel_key: session.channelKey,
    repo_path: session.repoPath,
    repo_name: session.repoName,
    title: session.title,
    status: session.status,
    activity: session.activity,
    model: session.model,
    created_at: session.createdAt,
    updated_at: session.updatedAt,
    closed_at: session.closedAt,
    error_message: session.errorMessage,
    output_preview: session.outputPreview,
  };
}
