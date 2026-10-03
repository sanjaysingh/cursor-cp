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
      AgentBusyError: class AgentBusyError extends Error {
        constructor(message: string) {
          super(message);
          this.name = 'AgentBusyError';
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

  it('should surface the SDK error when a run fails', async () => {
    mockAgent.send.mockResolvedValue({
      id: 'run-err',
      agentId: 'agent-test-id',
      store: {
        getRun: vi.fn().mockResolvedValue({ errorCode: 'Model blocked' }),
      },
      async *stream() {
        /* no output */
      },
      wait: vi.fn().mockResolvedValue({ id: 'run-err', status: 'error' }),
    });

    await service.createSession('test-id', '/tmp/workspace');
    const result = await service.sendPrompt('test-id', 'Hi');

    expect(result.success).toBe(false);
    expect(result.error).toBe('Model blocked');
    expect(sdkMock.Agent.resume).not.toHaveBeenCalled();
  });

  it('should restart the executor and retry once after an authentication error', async () => {
    mockAgent.send
      .mockResolvedValueOnce({
        id: 'run-auth',
        agentId: 'agent-test-id',
        store: {
          getRun: vi.fn().mockResolvedValue({
            errorCode: 'Authentication error If you are logged in, try logging out and back in.',
          }),
        },
        async *stream() {
          /* auth fails before any text */
        },
        wait: vi.fn().mockResolvedValue({ id: 'run-auth', status: 'error' }),
      })
      .mockResolvedValueOnce({
        id: 'run-ok',
        agentId: 'agent-test-id',
        async *stream() {
          yield {
            type: 'assistant',
            agent_id: 'agent-test-id',
            run_id: 'run-ok',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Recovered' }],
            },
          };
        },
        wait: vi.fn().mockResolvedValue({
          id: 'run-ok',
          status: 'finished',
          result: 'Recovered',
        }),
      });

    await service.createSession('test-id', '/tmp/workspace');
    const result = await service.sendPrompt('test-id', 'Hi again');

    expect(result.success).toBe(true);
    expect(result.text).toBe('Recovered');
    expect(mockAgent[Symbol.asyncDispose]).toHaveBeenCalled();
    expect(sdkMock.Agent.resume).toHaveBeenCalledWith('agent-test-id', {
      apiKey: 'test-key',
      model: { id: 'composer-2' },
      local: {
        cwd: '/tmp/workspace',
        settingSources: [],
      },
    });
    expect(mockAgent.send).toHaveBeenCalledTimes(2);
  });

  it('should report the authentication error when the retry also fails', async () => {
    const failedRun = {
      id: 'run-auth',
      agentId: 'agent-test-id',
      store: {
        getRun: vi.fn().mockResolvedValue({
          errorCode: 'Authentication error If you are logged in, try logging out and back in.',
        }),
      },
      async *stream() {
        /* still unauthenticated */
      },
      wait: vi.fn().mockResolvedValue({ id: 'run-auth', status: 'error' }),
    };
    mockAgent.send.mockResolvedValue(failedRun);

    await service.createSession('test-id', '/tmp/workspace');
    const result = await service.sendPrompt('test-id', 'Hi');

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      'Authentication error. If you are logged in, try logging out and back in.'
    );
    expect(mockAgent.send).toHaveBeenCalledTimes(2);
  });

  it('should retry send with local.force when agent has wedged active run', async () => {
    mockAgent.send
      .mockRejectedValueOnce(new Error('Agent already has active run'))
      .mockResolvedValueOnce({
        id: 'run-2',
        agentId: 'agent-test-id',
        async *stream() {
          yield {
            type: 'assistant',
            agent_id: 'agent-test-id',
            run_id: 'run-2',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Recovered' }],
            },
          };
        },
        wait: vi.fn().mockResolvedValue({
          id: 'run-2',
          status: 'finished',
          result: 'Recovered',
        }),
      });

    await service.createSession('test-id', '/tmp/workspace');
    const result = await service.sendPrompt('test-id', 'Hi again');

    expect(result.success).toBe(true);
    expect(mockAgent.send).toHaveBeenCalledTimes(2);
    expect(mockAgent.send).toHaveBeenNthCalledWith(1, 'Hi again');
    expect(mockAgent.send).toHaveBeenNthCalledWith(2, 'Hi again', { local: { force: true } });
  });

  it('should register question callback', async () => {
    const questionHandler = vi.fn().mockResolvedValue('Yes');
    service.onQuestion(questionHandler);

    await service.createSession('test-id', '/tmp/workspace');
    expect(service).toBeDefined();
  });

  it('should surface run errors from result.error', async () => {
    mockAgent.send.mockResolvedValue({
      id: 'run-err',
      requestId: 'req-err',
      async *stream() {
        yield* [];
      },
      wait: vi.fn().mockResolvedValue({
        id: 'run-err',
        status: 'error',
        error: { message: 'sandbox denied the command' },
      }),
    });

    await service.createSession('test-id', '/tmp/workspace');
    const result = await service.sendPrompt('test-id', 'Do the thing');

    expect(result.success).toBe(false);
    expect(result.status).toBe('error');
    expect(result.error).toBe('sandbox denied the command');
  });

  it('should not block the stream while a request is unanswered', async () => {
    let releaseQuestion: (() => void) | undefined;
    const question = new Promise<void>((resolve) => {
      releaseQuestion = resolve;
    });
    const onQuestion = vi.fn(() => question);

    mockAgent.send.mockResolvedValue({
      id: 'run-req',
      async *stream() {
        yield {
          type: 'request',
          agent_id: 'agent-test-id',
          run_id: 'run-req',
          request_id: 'req-1',
        };
        yield {
          type: 'assistant',
          agent_id: 'agent-test-id',
          run_id: 'run-req',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
        };
      },
      wait: vi.fn().mockResolvedValue({
        id: 'run-req',
        status: 'finished',
        result: 'Done',
      }),
    });

    service.onQuestion(onQuestion);
    await service.createSession('test-id', '/tmp/workspace');
    const result = await service.sendPrompt('test-id', 'Hi');

    expect(onQuestion).toHaveBeenCalledWith(
      'test-id',
      expect.objectContaining({ requestId: 'req-1' })
    );
    expect(result.success).toBe(true);
    expect(result.text).toBe('Done');
    releaseQuestion?.();
  });

  it('should cancel a run that never streams and still return', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const stalled = new AgentService({
      apiKey: 'test-key',
      defaultModel: 'composer-2',
      timeouts: { initialStallMs: 30, waitGraceMs: 30, maxRunMs: 5_000, sdkCallMs: 1_000 },
    });

    mockAgent.send.mockResolvedValue({
      id: 'run-hang',
      supports: () => true,
      cancel,
      async *stream() {
        await new Promise(() => {});
        yield* [];
      },
      wait: () => new Promise(() => {}),
    });

    await stalled.createSession('test-id', '/tmp/workspace');
    const result = await stalled.sendPrompt('test-id', 'Hi');

    expect(cancel).toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.status).toBe('cancelled');
    expect(result.error).toMatch(/cancelled/i);
  });

  it('should steer text into the active run', async () => {
    let releaseStream: (() => void) | undefined;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const steer = vi.fn().mockResolvedValue('complete_delivered');

    mockAgent.send.mockResolvedValue({
      id: 'run-steer',
      steer,
      async *stream() {
        await streamGate;
        yield* [];
      },
      wait: vi.fn().mockResolvedValue({
        id: 'run-steer',
        status: 'finished',
        result: 'ok',
      }),
    });

    await service.createSession('test-id', '/tmp/workspace');
    const pending = service.sendPrompt('test-id', 'Hi');
    await vi.waitFor(() => expect(service.hasActiveRun('test-id')).toBe(true));

    await expect(service.steerActiveRun('test-id', 'skip that')).resolves.toBe(true);
    expect(steer).toHaveBeenCalledWith('skip that');

    releaseStream?.();
    const result = await pending;
    expect(result.success).toBe(true);
    expect(result.text).toBe('ok');
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
