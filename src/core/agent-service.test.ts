/**
 * Tests for AgentService
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
        prompt: vi.fn(),
        resume: vi.fn(),
        list: vi.fn(),
      },
      Cursor: {
        models: {
          list: vi.fn().mockResolvedValue([
            { id: 'composer-2', displayName: 'Composer 2' },
            { id: 'auto', displayName: 'Auto' },
          ]),
        },
      },
      CursorAgentError: class CursorAgentError extends Error {
        isRetryable: boolean;
        constructor(message: string, isRetryable = false) {
          super(message);
          this.name = 'CursorAgentError';
          this.isRetryable = isRetryable;
        }
      },
    },
  };
});

vi.mock('@cursor/sdk', () => sdkMock);

import { AgentService } from './agent-service.js';

describe('AgentService', () => {
  let service: AgentService;

  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.Agent.create.mockResolvedValue(mockAgent);
    sdkMock.Agent.resume.mockResolvedValue(mockAgent);
    service = new AgentService({
      apiKey: 'test-key',
      defaultModel: 'composer-2',
    });
  });

  it('should initialize with correct options', () => {
    expect(service).toBeDefined();
  });

  it('should create session via Agent.create', async () => {
    const session = await service.createSession('test-id', '/tmp/workspace');

    expect(sdkMock.Agent.create).toHaveBeenCalledWith({
      apiKey: 'test-key',
      model: { id: 'composer-2' },
      local: {
        cwd: '/tmp/workspace',
        settingSources: [],
      },
    });
    expect(session).toBeDefined();
    expect(session.id).toBe('test-id');
    expect(session.workspacePath).toBe('/tmp/workspace');
    expect(session.model).toBe('composer-2');
    expect(session.sdkAgentId).toBe('agent-test-id');
  });

  it('should resume session via Agent.resume', async () => {
    const session = await service.resumeSession(
      'test-id',
      'agent-existing-id',
      '/tmp/workspace',
      'composer-2'
    );

    expect(sdkMock.Agent.resume).toHaveBeenCalledWith('agent-existing-id', {
      apiKey: 'test-key',
      model: { id: 'composer-2' },
      local: {
        cwd: '/tmp/workspace',
        settingSources: [],
      },
    });
    expect(session.id).toBe('test-id');
    expect(session.sdkAgentId).toBe('agent-test-id');
    expect(service.getSession('test-id')).toBeDefined();
  });

  it('should list sessions', () => {
    const sessions = service.listSessions();
    expect(Array.isArray(sessions)).toBe(true);
  });

  it('should handle session not found', async () => {
    const result = await service.sendPrompt('nonexistent-id', 'test');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Session not found');
  });

  it('should stream assistant output and wait for completion', async () => {
    mockAgent.send.mockResolvedValue({
      id: 'run-1',
      agentId: 'agent-test-id',
      async *stream() {
        yield {
          type: 'assistant',
          agent_id: 'agent-test-id',
          run_id: 'run-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'world' }],
          },
        };
      },
      wait: vi.fn().mockResolvedValue({
        id: 'run-1',
        status: 'finished',
        result: 'Hello world',
      }),
    });

    await service.createSession('test-id', '/tmp/workspace');
    const result = await service.sendPrompt('test-id', 'Hi');

    expect(result.success).toBe(true);
    expect(result.text).toBe('Hello world');
    expect(mockAgent.send).toHaveBeenCalledWith('Hi');
  });

  it('should register question callback', async () => {
    const questionHandler = vi.fn().mockResolvedValue('Yes');
    service.onQuestion(questionHandler);

    await service.createSession('test-id', '/tmp/workspace');
    expect(service).toBeDefined();
  });

  it('should list models via Cursor.models.list', async () => {
    const models = await service.listAvailableModels();

    expect(sdkMock.Cursor.models.list).toHaveBeenCalledWith({ apiKey: 'test-key' });
    expect(models).toEqual([
      { id: 'composer-2', name: 'Composer 2' },
      { id: 'auto', name: 'Auto' },
    ]);
  });
});
