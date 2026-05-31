/**
 * Tests for SessionManager
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockAgent, sdkMock } = vi.hoisted(() => {
  const mockAgent = {
    agentId: 'agent-test-id',
    model: { id: 'composer-2' },
    send: vi.fn(),
    close: vi.fn(),
    reload: vi.fn().mockResolvedValue(undefined),
    [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
    listArtifacts: vi.fn().mockResolvedValue([]),
    downloadArtifact: vi.fn(),
  };

  return {
    mockAgent,
    sdkMock: {
      Agent: {
        create: vi.fn().mockResolvedValue(mockAgent),
        resume: vi.fn().mockResolvedValue(mockAgent),
      },
      Cursor: {
        models: {
          list: vi.fn().mockResolvedValue([{ id: 'composer-2', displayName: 'Composer 2' }]),
        },
      },
      CursorAgentError: class CursorAgentError extends Error {
        isRetryable = false;
      },
    },
  };
});

vi.mock('@cursor/sdk', () => sdkMock);
import Database from 'better-sqlite3';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { unlinkSync } from 'fs';
import { SessionManager, SessionLimitError } from './session-manager.js';
import { AgentService } from './agent-service.js';
import { EventBus } from './events.js';
import {
  SessionRepository,
  MessageRepository,
  ParticipantRepository,
  SettingsRepository,
} from '../db/repositories.js';
import type { ChannelRegistry } from '../channels/base.js';

const mockRegistry: ChannelRegistry = {
  register: () => {},
  get: () => undefined,
  list: () => [],
  startAll: async () => {},
  stopAll: async () => {},
};

describe('SessionManager', () => {
  let db: Database.Database;
  let sessionManager: SessionManager;
  let agentService: AgentService;
  let eventBus: EventBus;
  let dbPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.Agent.create.mockResolvedValue(mockAgent);

    dbPath = resolve(tmpdir(), `test-sm-${Date.now()}.db`);
    db = new Database(dbPath);

    // Setup schema
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_sessions (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        channel_key TEXT NOT NULL,
        repo_path TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open',
        model TEXT,
        sdk_agent_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS session_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_participants (
        session_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        joined_at TEXT NOT NULL,
        PRIMARY KEY (session_id, channel, conversation_id)
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL DEFAULT ''
      );
    `);

    eventBus = new EventBus();
    agentService = new AgentService({
      apiKey: 'test-key',
      defaultModel: 'composer-2',
    });

    sessionManager = new SessionManager({
      repositories: {
        sessions: new SessionRepository(db),
        messages: new MessageRepository(db),
        participants: new ParticipantRepository(db),
        settings: new SettingsRepository(db),
      },
      agentService,
      eventBus,
      registry: mockRegistry,
      maxSessions: 2,
      defaultModel: 'composer-2',
    });
  });

  afterEach(async () => {
    // Clean up all sessions before closing DB
    try {
      await sessionManager.closeAllSessions();
    } catch { /* ignore */ }

    db.close();
    try {
      unlinkSync(dbPath);
    } catch { /* ignore */ }
  });

  describe('createSession', () => {
    it('should create a new session', async () => {
      const session = await sessionManager.createSession(
        'web',
        'web:default',
        '/tmp/repo',
        'Test Session'
      );

      expect(session).toBeDefined();
      expect(session.channel).toBe('web');
      expect(session.title).toBe('Test Session');
      expect(session.repoPath).toBe('/tmp/repo');
      expect(session.status).toBe('open');
    });

    it('should enforce session limit', async () => {
      await sessionManager.createSession('web', 'web:1', '/tmp/r1', 'S1');
      await sessionManager.createSession('web', 'web:2', '/tmp/r2', 'S2');

      await expect(
        sessionManager.createSession('web', 'web:3', '/tmp/r3', 'S3')
      ).rejects.toThrow(SessionLimitError);
    });

    it('should use provided model', async () => {
      const session = await sessionManager.createSession(
        'web',
        'web:default',
        '/tmp/repo',
        'Test',
        'claude-sonnet-4'
      );

      expect(session.model).toBe('claude-sonnet-4');
    });

    it('should persist sdk agent id', async () => {
      const session = await sessionManager.createSession('web', 'web:1', '/tmp/r1', 'S1');

      const fromDb = sessionManager.getSession(session.id);
      expect(fromDb?.sdkAgentId).toBe('agent-test-id');
    });
  });

  describe('rehydration after restart', () => {
    it('should resume SDK agent from persisted id', async () => {
      const session = await sessionManager.createSession('web', 'web:1', '/tmp/r1', 'S1');
      expect(session.sdkAgentId).toBe('agent-test-id');

      // Simulate process restart: new in-memory agent service, same DB
      await agentService.closeAllSessions();
      const restartedAgentService = new AgentService({
        apiKey: 'test-key',
        defaultModel: 'composer-2',
      });
      sdkMock.Agent.resume.mockResolvedValue(mockAgent);

      const restartedManager = new SessionManager({
        repositories: {
          sessions: new SessionRepository(db),
          messages: new MessageRepository(db),
          participants: new ParticipantRepository(db),
          settings: new SettingsRepository(db),
        },
        agentService: restartedAgentService,
        eventBus,
        registry: mockRegistry,
        maxSessions: 2,
        defaultModel: 'composer-2',
      });

      sdkMock.Agent.create.mockClear();
      sdkMock.Agent.resume.mockClear();

      mockAgent.send.mockResolvedValue({
        id: 'run-2',
        agentId: 'agent-test-id',
        async *stream() {
          yield {
            type: 'assistant',
            agent_id: 'agent-test-id',
            run_id: 'run-2',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Resumed reply' }],
            },
          };
        },
        wait: vi.fn().mockResolvedValue({
          id: 'run-2',
          status: 'finished',
          result: 'Resumed reply',
        }),
      });

      const joined = await restartedManager.joinSession(session.id, 'web', 'web:1');
      expect(joined).toBeDefined();
      expect(sdkMock.Agent.resume).toHaveBeenCalledWith(
        'agent-test-id',
        expect.objectContaining({
          apiKey: 'test-key',
          model: { id: 'composer-2' },
          local: expect.objectContaining({ cwd: '/tmp/r1' }),
        })
      );
      expect(sdkMock.Agent.create).not.toHaveBeenCalled();

      const result = await restartedManager.sendSessionMessage(session.id, 'Continue', 'web', 'web:1');
      expect(result.activity).not.toBe('error');
      expect(mockAgent.send).toHaveBeenCalledWith('Continue');
    });
  });

  describe('closeSession', () => {
    it('should close and delete session', async () => {
      const session = await sessionManager.createSession('web', 'web:1', '/tmp/r1', 'S1');

      const result = await sessionManager.closeSession(session.id);
      expect(result).toBe(true);

      const found = sessionManager.getSession(session.id);
      expect(found).toBeUndefined();
    });

    it('should return false for nonexistent session', async () => {
      const result = await sessionManager.closeSession('nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('listSessions', () => {
    it('should list sessions by channel', async () => {
      // Clean up from previous tests
      await sessionManager.closeAllSessions();

      await sessionManager.createSession('web', 'web:1', '/tmp/r1', 'S1');
      await sessionManager.createSession('web', 'web:1', '/tmp/r2', 'S2');

      const webSessions = sessionManager.listSessions('web', 'web:1', true);
      expect(webSessions).toHaveLength(2);
    });
  });

  describe('default model', () => {
    it('should get default model', () => {
      expect(sessionManager.getDefaultModel()).toBe('composer-2');
    });

    it('should set default model', () => {
      sessionManager.setDefaultModel('gpt-4');
      expect(sessionManager.getDefaultModel()).toBe('gpt-4');
    });

    it('should clear default model', () => {
      sessionManager.setDefaultModel('gpt-4');
      sessionManager.setDefaultModel(null);
      expect(sessionManager.getDefaultModel()).toBe('composer-2');
    });
  });
});
