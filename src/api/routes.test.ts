/**
 * Tests for API Routes
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import { registerApi, API_PREFIX } from './register-api.js';
import type { SessionManager } from '../core/session-manager.js';
import type { AgentService } from '../core/agent-service.js';
import type { WebChannel } from '../channels/web-channel.js';
import type { AppConfig } from '../models/types.js';

// Mocks
const mockSessionManager = {
  listAllSessions: vi.fn(),
  getSession: vi.fn(),
  getSessionMessages: vi.fn(),
  createSession: vi.fn(),
  closeSession: vi.fn(),
  closeAllSessions: vi.fn(),
  joinSession: vi.fn(),
  sendSessionMessage: vi.fn(),
  submitIncoming: vi.fn(),
  getDefaultModel: vi.fn(),
  setDefaultModel: vi.fn(),
} as unknown as SessionManager;

const mockAgentService = {
  listAvailableModels: vi.fn(),
} as unknown as AgentService;

const mockWebChannel = {
  submitAnswer: vi.fn(),
} as unknown as WebChannel;

const mockConfig: AppConfig = {
  repos: [],
  workspaceRoot: '/tmp/test-workspace',
  channels: {
    telegram: { enabled: false },
    web: { enabled: true },
  },
  server: {
    host: '0.0.0.0',
    port: 8747,
  },
  sdk: {
    defaultModel: 'composer-2',
    maxSessions: 5,
  },
};

async function buildApp(webChannel?: WebChannel) {
  const app = Fastify();
  await registerApi(app, {
    eventBus: { on: vi.fn(), emit: vi.fn() } as never,
    sessionManager: mockSessionManager,
    agentService: mockAgentService,
    webChannel,
    config: mockConfig,
  });
  return app;
}

function apiUrl(path: string): string {
  return `${API_PREFIX}${path}`;
}

describe('API Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /health', () => {
    it('should return ok status', async () => {
      const app = await buildApp(mockWebChannel);
      const response = await app.inject({
        method: 'GET',
        url: apiUrl('/health'),
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload)).toEqual({
        status: 'ok',
        version: '0.1.0',
      });
    });
  });

  describe('GET /dashboard-config', () => {
    it('should return dashboard configuration', async () => {
      vi.mocked(mockSessionManager.getDefaultModel).mockReturnValue('composer-2');
      const app = await buildApp(mockWebChannel);

      const response = await app.inject({
        method: 'GET',
        url: apiUrl('/dashboard-config'),
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      expect(payload.web_channel_key).toBe('web:default');
      expect(payload.workspace_root).toBe('/tmp/test-workspace');
      expect(payload.default_model).toBe('composer-2');
      expect(payload.max_sessions).toBe(5);
    });
  });

  describe('GET /models', () => {
    it('should return list of models', async () => {
      vi.mocked(mockAgentService.listAvailableModels).mockResolvedValue([
        { id: 'composer-2', name: 'Composer 2' },
        { id: 'composer-1', name: 'Composer 1' },
      ]);
      const app = await buildApp(mockWebChannel);

      const response = await app.inject({
        method: 'GET',
        url: apiUrl('/models'),
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      expect(payload.models).toHaveLength(2);
      expect(payload.error).toBeNull();
      expect(payload.source).toBe('sdk');
    });
  });

  describe('PUT /settings/default-model', () => {
    it('should update default model', async () => {
      vi.mocked(mockSessionManager.getDefaultModel).mockReturnValue('composer-1');
      const app = await buildApp(mockWebChannel);

      const response = await app.inject({
        method: 'PUT',
        url: apiUrl('/settings/default-model'),
        payload: { model: 'composer-1' },
      });

      expect(response.statusCode).toBe(200);
      expect(mockSessionManager.setDefaultModel).toHaveBeenCalledWith('composer-1');
      const payload = JSON.parse(response.payload);
      expect(payload.ok).toBe(true);
      expect(payload.default_model).toBe('composer-1');
    });

    it('should allow empty string model (auto)', async () => {
      const app = await buildApp(mockWebChannel);

      const response = await app.inject({
        method: 'PUT',
        url: apiUrl('/settings/default-model'),
        payload: { model: '' },
      });

      expect(response.statusCode).toBe(200);
      // The route passes the model value directly, null or empty string
      expect(mockSessionManager.setDefaultModel).toHaveBeenCalledWith(expect.any(String));
    });
  });

  describe('GET /workspaces', () => {
    it('should return workspace directories', async () => {
      const app = await buildApp(mockWebChannel);

      const response = await app.inject({
        method: 'GET',
        url: apiUrl('/workspaces'),
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      expect(payload.items).toBeDefined();
      expect(Array.isArray(payload.items)).toBe(true);
    });
  });

  describe('GET /github/repos', () => {
    it('should return repos or error', async () => {
      const app = await buildApp(mockWebChannel);

      const response = await app.inject({
        method: 'GET',
        url: apiUrl('/github/repos'),
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      // May return repos if gh CLI is available, or error if not
      expect(payload).toHaveProperty('repos');
      expect(payload).toHaveProperty('error');
    });
  });

  describe('GET /repo-picker', () => {
    it('should return repo picker items', async () => {
      const app = await buildApp(mockWebChannel);

      const response = await app.inject({
        method: 'GET',
        url: apiUrl('/repo-picker'),
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      expect(payload.items).toBeDefined();
      expect(payload.error).toBeDefined();
    });
  });

  describe('GET /sessions', () => {
    it('should return active sessions by default', async () => {
      vi.mocked(mockSessionManager.listAllSessions).mockReturnValue([
        {
          id: 's1',
          channel: 'web',
          channelKey: 'web:default',
          repoPath: '/tmp/repo',
          repoName: 'repo',
          title: 'Test Session',
          status: 'open',
          activity: 'idle',
          model: 'composer-2',
          createdAt: '2024-01-01',
          updatedAt: '2024-01-01',
          closedAt: null,
          errorMessage: null,
          outputPreview: '',
        },
      ]);
      const app = await buildApp(mockWebChannel);

      const response = await app.inject({
        method: 'GET',
        url: apiUrl('/sessions'),
      });

      expect(response.statusCode).toBe(200);
      expect(mockSessionManager.listAllSessions).toHaveBeenCalledWith(false);
      const payload = JSON.parse(response.payload);
      expect(payload).toHaveLength(1);
      expect(payload[0].title).toBe('Test Session');
    });

    it('should include closed sessions when requested', async () => {
      vi.mocked(mockSessionManager.listAllSessions).mockReturnValue([]);
      const app = await buildApp(mockWebChannel);

      await app.inject({
        method: 'GET',
        url: apiUrl('/sessions?include_closed=true'),
      });

      expect(mockSessionManager.listAllSessions).toHaveBeenCalledWith(true);
    });
  });

  describe('POST /sessions', () => {
    it('should create a new session without repoPath', async () => {
      const mockSession = {
        id: 's1',
        channel: 'web',
        channelKey: 'web:default',
        repoPath: '',
        repoName: '',
        title: 'New Session',
        status: 'open',
        activity: 'idle',
        model: 'composer-2',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        closedAt: null,
        errorMessage: null,
        outputPreview: '',
      };
      vi.mocked(mockSessionManager.createSession).mockResolvedValue(mockSession);
      const app = await buildApp(mockWebChannel);

      const response = await app.inject({
        method: 'POST',
        url: apiUrl('/sessions'),
        payload: {
          title: 'New Session',
          model: 'composer-2',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(mockSessionManager.createSession).toHaveBeenCalledWith(
        'web',
        'web:default',
        '',
        'New Session',
        'composer-2'
      );
    });

    it('should handle session limit error', async () => {
      const error = new Error('Maximum 5 sessions reached');
      error.name = 'SessionLimitError';
      vi.mocked(mockSessionManager.createSession).mockRejectedValue(error);
      const app = await buildApp(mockWebChannel);

      const response = await app.inject({
        method: 'POST',
        url: apiUrl('/sessions'),
        payload: { title: 'Test' },
      });

      expect(response.statusCode).toBe(400);
      const payload = JSON.parse(response.payload);
      expect(payload.error).toContain('Maximum 5 sessions');
    });
  });

  describe('POST /sessions/close-all', () => {
    it('should close all sessions', async () => {
      vi.mocked(mockSessionManager.closeAllSessions).mockResolvedValue(3);
      const app = await buildApp(mockWebChannel);

      const response = await app.inject({
        method: 'POST',
        url: apiUrl('/sessions/close-all'),
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      expect(payload.ok).toBe(true);
      expect(payload.deleted).toBe(3);
    });
  });

  describe('GET /sessions/:sessionId', () => {
    it('should return session by id', async () => {
      const mockSession = {
        id: 's1',
        channel: 'web',
        channelKey: 'web:default',
        repoPath: '/tmp/repo',
        repoName: 'repo',
        title: 'Test',
        status: 'open',
        activity: 'idle',
        model: null,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        closedAt: null,
        errorMessage: null,
        outputPreview: '',
      };
      vi.mocked(mockSessionManager.getSession).mockReturnValue(mockSession);
      const app = await buildApp(mockWebChannel);

      const response = await app.inject({
        method: 'GET',
        url: apiUrl('/sessions/s1'),
      });

      expect(response.statusCode).toBe(200);
      expect(mockSessionManager.getSession).toHaveBeenCalledWith('s1');
    });

    it('should return 404 for nonexistent session', async () => {
      vi.mocked(mockSessionManager.getSession).mockReturnValue(undefined);
      const app = await buildApp(mockWebChannel);

      const response = await app.inject({
        method: 'GET',
        url: apiUrl('/sessions/nonexistent'),
      });

      expect(response.statusCode).toBe(404);
      const payload = JSON.parse(response.payload);
      expect(payload.error).toBe('Session not found');
    });
  });

  describe('POST /sessions/:sessionId/join', () => {
    it('should join a session', async () => {
      const mockSession = {
        id: 's1',
        channel: 'web',
        channelKey: 'web:default',
        repoPath: '/tmp/repo',
        repoName: 'repo',
        title: 'Test',
        status: 'open',
        activity: 'idle',
        model: null,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        closedAt: null,
        errorMessage: null,
        outputPreview: '',
      };
      vi.mocked(mockSessionManager.joinSession).mockResolvedValue(mockSession);
      const app = await buildApp(mockWebChannel);

      const response = await app.inject({
        method: 'POST',
        url: apiUrl('/sessions/s1/join'),
      });

      expect(response.statusCode).toBe(200);
      expect(mockSessionManager.joinSession).toHaveBeenCalledWith('s1', 'web', 'web:default');
    });

    it('should return 404 when session not found', async () => {
      vi.mocked(mockSessionManager.joinSession).mockResolvedValue(null);
      const app = await buildApp(mockWebChannel);

      const response = await app.inject({
        method: 'POST',
        url: apiUrl('/sessions/nonexistent/join'),
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('POST /sessions/:sessionId/message', () => {
    it('should send message to session', async () => {
      const mockSession = {
        id: 's1',
        channel: 'web',
        channelKey: 'web:default',
        repoPath: '/tmp/repo',
        repoName: 'repo',
        title: 'Test',
        status: 'open',
        activity: 'running',
        model: null,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        closedAt: null,
        errorMessage: null,
        outputPreview: '',
      };
      vi.mocked(mockSessionManager.sendSessionMessage).mockResolvedValue(mockSession);
      const app = await buildApp(mockWebChannel);

      const response = await app.inject({
        method: 'POST',
        url: apiUrl('/sessions/s1/message'),
        payload: { text: 'Hello' },
      });

      expect(response.statusCode).toBe(200);
      expect(mockSessionManager.sendSessionMessage).toHaveBeenCalledWith(
        's1',
        'Hello',
        'web',
        'web:default'
      );
    });

    it('should return 404 when session not found', async () => {
      const error = new Error('Session not found');
      vi.mocked(mockSessionManager.sendSessionMessage).mockRejectedValue(error);
      const app = await buildApp(mockWebChannel);

      const response = await app.inject({
        method: 'POST',
        url: apiUrl('/sessions/s1/message'),
        payload: { text: 'Hello' },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('POST /sessions/:sessionId/close', () => {
    it('should close a session', async () => {
      vi.mocked(mockSessionManager.closeSession).mockResolvedValue(true);
      const app = await buildApp(mockWebChannel);

      const response = await app.inject({
        method: 'POST',
        url: apiUrl('/sessions/s1/close'),
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      expect(payload.ok).toBe(true);
      expect(payload.session_id).toBe('s1');
    });

    it('should return 404 when session not found', async () => {
      vi.mocked(mockSessionManager.closeSession).mockResolvedValue(false);
      const app = await buildApp(mockWebChannel);

      const response = await app.inject({
        method: 'POST',
        url: apiUrl('/sessions/nonexistent/close'),
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('POST /sessions/:sessionId/answer', () => {
    it('should submit answer to question', async () => {
      vi.mocked(mockWebChannel.submitAnswer).mockReturnValue(true);
      const app = await buildApp(mockWebChannel);

      const response = await app.inject({
        method: 'POST',
        url: apiUrl('/sessions/s1/answer'),
        payload: { answer: 'Yes' },
      });

      expect(response.statusCode).toBe(200);
      expect(mockWebChannel.submitAnswer).toHaveBeenCalledWith('s1', 'Yes', 'web:default');
    });

    it('should return 404 when no pending question', async () => {
      vi.mocked(mockWebChannel.submitAnswer).mockReturnValue(false);
      const app = await buildApp(mockWebChannel);

      const response = await app.inject({
        method: 'POST',
        url: apiUrl('/sessions/s1/answer'),
        payload: { answer: 'Yes' },
      });

      expect(response.statusCode).toBe(404);
    });

    it('should return 503 when web channel not available', async () => {
      const app = await buildApp(undefined);

      const response = await app.inject({
        method: 'POST',
        url: apiUrl('/sessions/s1/answer'),
        payload: { answer: 'Yes' },
      });

      expect(response.statusCode).toBe(503);
      const payload = JSON.parse(response.payload);
      expect(payload.error).toBe('Web channel not enabled');
    });
  });

  // API Compatibility Aliases
  describe('GET /runs', () => {
    it('should list runs (alias for sessions)', async () => {
      vi.mocked(mockSessionManager.listAllSessions).mockReturnValue([]);
      const app = await buildApp(mockWebChannel);

      const response = await app.inject({
        method: 'GET',
        url: apiUrl('/runs'),
      });

      expect(response.statusCode).toBe(200);
      expect(mockSessionManager.listAllSessions).toHaveBeenCalledWith(true);
    });
  });

  describe('POST /runs', () => {
    it('should create a run (alias for session)', async () => {
      const mockSession = {
        id: 's1',
        channel: 'web',
        channelKey: 'web:default',
        repoPath: '/tmp/repo',
        repoName: 'repo',
        title: 'Run',
        status: 'open',
        activity: 'idle',
        model: null,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        closedAt: null,
        errorMessage: null,
        outputPreview: '',
      };
      vi.mocked(mockSessionManager.submitIncoming).mockResolvedValue(mockSession);
      const app = await buildApp(mockWebChannel);

      const response = await app.inject({
        method: 'POST',
        url: apiUrl('/runs'),
        payload: {
          conversationId: 'c1',
          prompt: 'Test prompt',
          repoPath: '/tmp/repo',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(mockSessionManager.submitIncoming).toHaveBeenCalled();
    });
  });

  describe('POST /runs/:sessionId/stop', () => {
    it('should stop a run (alias for close)', async () => {
      vi.mocked(mockSessionManager.closeSession).mockResolvedValue(true);
      const app = await buildApp(mockWebChannel);

      const response = await app.inject({
        method: 'POST',
        url: apiUrl('/runs/s1/stop'),
      });

      expect(response.statusCode).toBe(200);
    });
  });

  describe('POST /runs/:sessionId/answer', () => {
    it('should submit answer (alias)', async () => {
      vi.mocked(mockWebChannel.submitAnswer).mockReturnValue(true);
      const app = await buildApp(mockWebChannel);

      const response = await app.inject({
        method: 'POST',
        url: apiUrl('/runs/s1/answer'),
        payload: { answer: 'Option A' },
      });

      expect(response.statusCode).toBe(200);
    });
  });
});
