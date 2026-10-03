/**
 * Cursor SDK Agent Service
 * Manages agent lifecycle using the official @cursor/sdk
 */

import {
  Agent,
  AgentBusyError,
  Cursor,
  CursorAgentError,
  type Run,
  type RunResult,
  type SDKAgent,
} from '@cursor/sdk';
import type { AgentActivity } from '../models/types.js';
import {
  errorMessage,
  formatRunFailure,
  isAuthRequiredError,
  isWedgedActiveRunError,
} from '../util/agent-errors.js';
import { logger } from '../util/logger.js';

/**
 * Fields the current docs add on top of the installed SDK types.
 * `steer` and `error` are used when present and ignored otherwise.
 */
type LiveRun = Run & {
  requestId?: string;
  steer?(text: string): Promise<'complete_delivered' | 'revert_to_followup'>;
};

type LiveRunResult = RunResult & {
  requestId?: string;
  error?: { message: string; code?: string };
};

function liveRun(run: Run): LiveRun {
  return run as LiveRun;
}

function liveResult(result: RunResult): LiveRunResult {
  return result as LiveRunResult;
}

export interface AgentRunResult {
  success: boolean;
  /** Terminal run status. `finished` is the only success. */
  status: 'finished' | 'error' | 'cancelled';
  error?: string;
  text: string;
}

/** Bounds for one agent.send. Stalls are cancelled via run.cancel(), then wait(). */
export interface AgentRunTimeouts {
  /** No stream events yet. The run is treated as wedged and cancelled. */
  initialStallMs: number;
  /** Absolute cap from send() until the run must be cancelled. */
  maxRunMs: number;
  /** How long wait() may take after the stream ends or cancel() is requested. */
  waitGraceMs: number;
  /** agent.send / Agent.create / Agent.resume must return within this. */
  sdkCallMs: number;
}

export const DEFAULT_AGENT_RUN_TIMEOUTS: AgentRunTimeouts = {
  initialStallMs: 5 * 60 * 1000,
  maxRunMs: 45 * 60 * 1000,
  waitGraceMs: 30 * 1000,
  sdkCallMs: 2 * 60 * 1000,
};

const MAX_INPUT_FOLLOW_UPS = 3;

export interface AgentSession {
  id: string;
  agent: SDKAgent;
  sdkAgentId: string;
  model: string;
  workspacePath: string;
  activity: AgentActivity;
  outputBuffer: string;
  createdAt: Date;
}

interface RunErrorStore {
  getRun(
    agentId: string,
    runId: string
  ): Promise<{ errorCode?: string | null } | null | undefined>;
}

interface StreamChunk {
  text: string;
  type: 'text' | 'tool' | 'error' | 'thinking' | 'status';
}

export interface AgentQuestion {
  question: string;
  options: string[];
  requestId?: string;
}

export class AgentService {
  private sessions: Map<string, AgentSession> = new Map();
  private apiKey: string;
  private defaultModel: string;
  private timeouts: AgentRunTimeouts;
  private onStreamCallback?: (sessionId: string, chunk: StreamChunk) => void;
  /** Notifies the host. Must not be awaited inside run.stream() — that stalls the run. */
  private onQuestionCallback?: (sessionId: string, question: AgentQuestion) => void | Promise<void>;
  /** Live runs, keyed by session id, so a later message can steer. */
  private activeRuns = new Map<string, Run>();
  /** True for the whole sendPrompt, including follow-up sends. */
  private inFlight = new Set<string>();
  /** Answers that steer() could not take. Sent as the next prompt on this run. */
  private followUps = new Map<string, string[]>();
  /** Next send uses local.force after we cancelled a wedged run. */
  private stuckAgents = new Set<string>();

  constructor(options: { apiKey: string; defaultModel: string; timeouts?: Partial<AgentRunTimeouts> }) {
    this.apiKey = options.apiKey;
    this.defaultModel = options.defaultModel;
    this.timeouts = { ...DEFAULT_AGENT_RUN_TIMEOUTS, ...options.timeouts };
  }

  onStream(callback: (sessionId: string, chunk: StreamChunk) => void): void {
    this.onStreamCallback = callback;
  }

  onQuestion(callback: (sessionId: string, question: AgentQuestion) => void | Promise<void>): void {
    this.onQuestionCallback = callback;
  }

  hasActiveRun(sessionId: string): boolean {
    return this.activeRuns.has(sessionId);
  }

  /**
   * Inject text into the turn that is already running.
   * `complete_delivered` means the turn has the message — do not send it again.
   */
  async steerActiveRun(sessionId: string, text: string): Promise<boolean> {
    const trimmed = text.trim();
    if (!trimmed) return false;

    const run = this.activeRuns.get(sessionId);
    const steer = run ? liveRun(run).steer : undefined;
    if (!run || !steer) return false;

    try {
      const outcome = await steer(trimmed);
      if (outcome === 'complete_delivered') {
        logger.info({ sessionId, runId: run.id }, 'Steered message into the active run');
        return true;
      }
      logger.info({ sessionId, runId: run.id, outcome }, 'Run did not accept steer');
      return false;
    } catch (err) {
      logger.warn({ err, sessionId, runId: run.id }, 'steer failed');
      return false;
    }
  }

  /**
   * Deliver user input for a `request` event.
   * Steer when a run is live; otherwise the caller should agent.send() it.
   */
  async submitUserInput(sessionId: string, text: string): Promise<'steered' | 'queued' | 'send-now'> {
    const trimmed = text.trim();
    if (!trimmed) return 'send-now';

    if (await this.steerActiveRun(sessionId, trimmed)) {
      return 'steered';
    }

    if (!this.inFlight.has(sessionId)) {
      return 'send-now';
    }

    const queue = this.followUps.get(sessionId) ?? [];
    queue.push(trimmed);
    this.followUps.set(sessionId, queue);
    logger.info({ sessionId }, 'Queued user input for the next prompt on this run');
    return 'queued';
  }

  async createSession(
    sessionId: string,
    workspacePath: string,
    model?: string | null
  ): Promise<AgentSession> {
    const effectiveModel = model || this.defaultModel;

    const agent = await withTimeout(
      Agent.create({
        apiKey: this.apiKey,
        model: { id: effectiveModel },
        local: {
          cwd: workspacePath,
          // Avoid loading ambient IDE settings in a headless service.
          settingSources: [],
        },
      }),
      this.timeouts.sdkCallMs,
      'Agent.create'
    );

    const session: AgentSession = {
      id: sessionId,
      agent,
      sdkAgentId: agent.agentId,
      model: effectiveModel,
      workspacePath,
      activity: 'idle',
      outputBuffer: '',
      createdAt: new Date(),
    };

    this.sessions.set(sessionId, session);
    return session;
  }

  async resumeSession(
    sessionId: string,
    sdkAgentId: string,
    workspacePath: string,
    model?: string | null
  ): Promise<AgentSession> {
    const effectiveModel = model || this.defaultModel;
    const cwd = workspacePath || process.cwd();

    const agent = await withTimeout(
      Agent.resume(sdkAgentId, {
        apiKey: this.apiKey,
        model: { id: effectiveModel },
        local: {
          cwd,
          settingSources: [],
        },
      }),
      this.timeouts.sdkCallMs,
      'Agent.resume'
    );

    const session: AgentSession = {
      id: sessionId,
      agent,
      sdkAgentId: agent.agentId,
      model: effectiveModel,
      workspacePath: cwd,
      activity: 'idle',
      outputBuffer: '',
      createdAt: new Date(),
    };

    this.sessions.set(sessionId, session);
    logger.info({ sessionId, sdkAgentId: agent.agentId, cwd }, 'Agent session resumed');
    return session;
  }

  async sendPrompt(sessionId: string, prompt: string): Promise<AgentRunResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { success: false, status: 'error', error: 'Session not found', text: '' };
    }

    session.activity = 'running';
    session.outputBuffer = '';
    this.inFlight.add(sessionId);

    let authRetried = false;

    try {
      let nextPrompt: string | undefined = prompt;
      let followUps = 0;
      let last: AgentRunResult = { success: true, status: 'finished', text: '' };

      while (nextPrompt) {
        const currentPrompt: string = nextPrompt;
        try {
          last = await this.executeRun(session, currentPrompt);
        } catch (err) {
          if (!authRetried && isAuthRequiredError(err)) {
            authRetried = true;
            const recovered = await this.recoverAuth(session, err);
            if (!recovered) {
              return this.withUnsentInput(sessionId, {
                success: false,
                status: 'error',
                error: errorMessage(err),
                text: session.outputBuffer,
              });
            }
            nextPrompt = currentPrompt;
            continue;
          }
          throw err;
        }

        if (!last.success && !authRetried && last.error && isAuthRequiredError(last.error)) {
          authRetried = true;
          const recovered = await this.recoverAuth(session, last.error);
          if (!recovered) {
            return this.withUnsentInput(sessionId, last);
          }
          nextPrompt = currentPrompt;
          continue;
        }

        if (!last.success) {
          return this.withUnsentInput(sessionId, last);
        }

        const queued = this.dequeueFollowUp(sessionId);
        if (!queued || followUps >= MAX_INPUT_FOLLOW_UPS) {
          if (queued) {
            last = {
              ...last,
              text: [last.text.trim(), `Not sent yet: ${queued}`].filter(Boolean).join('\n\n'),
            };
          }
          return last;
        }

        followUps += 1;
        nextPrompt = queued;
      }

      return last;
    } catch (err) {
      session.activity = 'error';
      logger.error({ err, sessionId }, 'Agent sendPrompt failed');
      return this.withUnsentInput(sessionId, this.failureResult(session, err));
    } finally {
      this.inFlight.delete(sessionId);
      this.activeRuns.delete(sessionId);
    }
  }

  /** Restart the local executor once after a stale login. Returns false if that restart fails. */
  private async recoverAuth(session: AgentSession, err: unknown): Promise<boolean> {
    try {
      await this.recreateAgentAfterAuthFailure(session);
      session.outputBuffer = '';
      return true;
    } catch (recoverErr) {
      logger.error({ err: recoverErr, sessionId: session.id, cause: errorMessage(err) }, 'Auth recovery failed');
      session.activity = 'error';
      return false;
    }
  }

  /**
   * One send → stream → wait cycle, as the SDK requires.
   * Stream events are observed live. wait() is always called.
   * A stall cancels the run so wait() can resolve instead of hanging.
   */
  private async executeRun(session: AgentSession, prompt: string): Promise<AgentRunResult> {
    const sessionId = session.id;
    session.outputBuffer = '';
    session.activity = 'running';

    logger.info({ sessionId, agentId: session.sdkAgentId }, 'Sending prompt to agent');
    const run = await this.sendPromptToAgent(session, prompt);
    this.activeRuns.set(sessionId, run);
    logger.info(
      { sessionId, agentId: session.sdkAgentId, runId: run.id, requestId: liveRun(run).requestId },
      'Agent run started'
    );

    const watchdog = this.createWatchdog(sessionId, run);
    const streaming = this.consumeRunStream(sessionId, session, run, () => watchdog.touch()).catch(
      (err: unknown) => {
        if (watchdog.reason) {
          logger.debug({ err, sessionId, runId: run.id }, 'Stream closed after cancel');
          return;
        }
        throw err;
      }
    );
    let streamError: unknown;
    try {
      await Promise.race([streaming, watchdog.aborted]);
    } catch (err) {
      streamError = err;
      logger.error({ err, sessionId, runId: run.id }, 'Agent stream failed');
      await this.cancelRun(run, sessionId);
    } finally {
      watchdog.stop();
    }

    const result = await this.waitForRun(run, session);
    const text = this.finalText(session, result.result);

    if (streamError && result.status === 'finished') {
      return {
        success: false,
        status: 'error',
        error: streamError instanceof Error ? streamError.message : String(streamError),
        text,
      };
    }

    const settled = liveResult(result);

    if (result.status === 'error') {
      session.activity = 'error';
      const detail = (await this.readRunErrorDetail(run)) || settled.error?.message;
      const message = formatRunFailure(result.id, detail);
      logger.error({ sessionId, runId: result.id, requestId: settled.requestId, error: message }, 'Agent run failed');
      return { success: false, status: 'error', error: message, text };
    }

    if (result.status === 'cancelled') {
      session.activity = 'idle';
      const message = watchdog.reason ?? `Agent run cancelled (${result.id})`;
      logger.warn({ sessionId, runId: result.id, requestId: settled.requestId }, message);
      return { success: false, status: 'cancelled', error: message, text };
    }

    session.activity = 'idle';
    logger.info(
      { sessionId, runId: result.id, requestId: settled.requestId, textLength: text.length },
      'Agent run completed'
    );
    return { success: true, status: 'finished', text };
  }

  private failureResult(session: AgentSession, err: unknown): AgentRunResult {
    if (err instanceof AgentBusyError || isWedgedActiveRunError(err)) {
      return {
        success: false,
        status: 'error',
        error:
          'Agent is busy with a previous run. Close the session and start a new one, or wait for the current run to finish.',
        text: session.outputBuffer,
      };
    }

    if (err instanceof CursorAgentError) {
      return {
        success: false,
        status: 'error',
        error: `Startup failed: ${err.message} (retryable: ${err.isRetryable})`,
        text: session.outputBuffer,
      };
    }

    return {
      success: false,
      status: 'error',
      error: errorMessage(err),
      text: session.outputBuffer,
    };
  }

  /**
   * The local executor is cached for the life of the process and keeps the
   * login it minted at startup. When that login expires, runs fail immediately
   * with an authentication error until the executor is disposed and created again.
   */
  private async recreateAgentAfterAuthFailure(session: AgentSession): Promise<void> {
    logger.warn(
      { sessionId: session.id, agentId: session.sdkAgentId },
      'Authentication failed; restarting agent executor and retrying'
    );

    try {
      await session.agent[Symbol.asyncDispose]();
    } catch (err) {
      logger.warn({ err, sessionId: session.id }, 'Error disposing agent during auth recovery');
    }

    const agent = await withTimeout(
      Agent.resume(session.sdkAgentId, {
        apiKey: this.apiKey,
        model: { id: session.model },
        local: {
          cwd: session.workspacePath,
          settingSources: [],
        },
      }),
      this.timeouts.sdkCallMs,
      'Agent.resume'
    );

    session.agent = agent;
    session.sdkAgentId = agent.agentId;
  }

  /** `Run.wait()` drops the SDK error text; it is stored on the run record. */
  private async readRunErrorDetail(run: Run): Promise<string | undefined> {
    const store = (run as Run & { store?: RunErrorStore }).store;
    if (!store || typeof store.getRun !== 'function') {
      return undefined;
    }

    try {
      const record = await store.getRun(run.agentId, run.id);
      const detail = record?.errorCode?.trim();
      return detail || undefined;
    } catch (err) {
      logger.warn({ err, runId: run.id }, 'Failed to read agent run error');
      return undefined;
    }
  }

  private withUnsentInput(sessionId: string, result: AgentRunResult): AgentRunResult {
    const unsent = this.drainFollowUps(sessionId);
    if (!unsent) return result;
    return {
      ...result,
      text: [result.text.trim(), `Not sent yet: ${unsent}`].filter(Boolean).join('\n\n'),
    };
  }

  private dequeueFollowUp(sessionId: string): string | undefined {
    const queue = this.followUps.get(sessionId);
    if (!queue?.length) return undefined;
    const next = queue.shift();
    if (!queue.length) this.followUps.delete(sessionId);
    return next;
  }

  private drainFollowUps(sessionId: string): string {
    const queue = this.followUps.get(sessionId) ?? [];
    this.followUps.delete(sessionId);
    return queue.join('\n');
  }

  private createWatchdog(sessionId: string, run: Run): {
    aborted: Promise<void>;
    touch: () => void;
    stop: () => void;
    reason?: string;
  } {
    const startedAt = Date.now();
    let sawEvent = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reason: string | undefined;
    let abort: () => void = () => {};
    const aborted = new Promise<void>((resolve) => {
      abort = resolve;
    });

    const arm = () => {
      if (timer) clearTimeout(timer);
      const remainingMax = Math.max(0, this.timeouts.maxRunMs - (Date.now() - startedAt));
      const delay = sawEvent ? remainingMax : Math.min(this.timeouts.initialStallMs, remainingMax);
      timer = setTimeout(() => {
        reason = sawEvent
          ? `Agent run exceeded ${formatDuration(this.timeouts.maxRunMs)} and was cancelled`
          : `Agent produced no stream events for ${formatDuration(this.timeouts.initialStallMs)} and was cancelled`;
        logger.warn({ sessionId, runId: run.id, reason }, 'Cancelling stalled agent run');
        void this.cancelRun(run, sessionId).finally(abort);
      }, delay);
    };

    arm();

    return {
      aborted,
      touch: () => {
        sawEvent = true;
        arm();
      },
      stop: () => {
        if (timer) clearTimeout(timer);
      },
      get reason() {
        return reason;
      },
    };
  }

  private async waitForRun(run: Run, session: AgentSession): Promise<RunResult> {
    try {
      return await withTimeout(run.wait(), this.timeouts.waitGraceMs, 'run.wait');
    } catch (err) {
      logger.warn({ err, runId: run.id, sessionId: session.id }, 'run.wait did not settle; cancelling');
      await this.cancelRun(run, session.id);
      return {
        id: run.id,
        status: 'cancelled',
        result: session.outputBuffer,
      };
    }
  }

  private async cancelRun(run: Run, sessionId: string): Promise<void> {
    this.stuckAgents.add(sessionId);
    try {
      if (typeof run.supports === 'function' && !run.supports('cancel')) {
        logger.warn(
          { runId: run.id, reason: run.unsupportedReason?.('cancel') },
          'Run does not support cancel'
        );
        return;
      }
      await run.cancel();
      logger.info({ runId: run.id, sessionId }, 'Cancelled agent run');
    } catch (err) {
      logger.warn({ err, runId: run.id, sessionId }, 'Failed to cancel agent run');
    }
  }

  /**
   * Send a prompt, retrying once with local.force when the SDK store has a wedged run
   * (common after SIGTERM/restart mid-agent-run).
   */
  private async sendPromptToAgent(session: AgentSession, prompt: string): Promise<Run> {
    const force = this.stuckAgents.delete(session.id);
    if (force) {
      logger.warn({ sessionId: session.id, agentId: session.sdkAgentId }, 'Retrying send with local.force');
      return await withTimeout(
        session.agent.send(prompt, { local: { force: true } }),
        this.timeouts.sdkCallMs,
        'agent.send'
      );
    }

    try {
      return await withTimeout(session.agent.send(prompt), this.timeouts.sdkCallMs, 'agent.send');
    } catch (err) {
      if (!isWedgedActiveRunError(err)) {
        if (isTimeoutError(err)) this.stuckAgents.add(session.id);
        throw err;
      }
      logger.warn(
        { agentId: session.sdkAgentId, sessionId: session.id },
        'Agent has wedged active run; retrying with local.force'
      );
      return await withTimeout(
        session.agent.send(prompt, { local: { force: true } }),
        this.timeouts.sdkCallMs,
        'agent.send'
      );
    }
  }

  private finalText(session: AgentSession, runResult?: string): string {
    return session.outputBuffer || runResult || '';
  }

  private emitChunk(sessionId: string, session: AgentSession, chunk: StreamChunk): void {
    if (chunk.type === 'text') {
      session.outputBuffer += chunk.text;
    }
    this.onStreamCallback?.(sessionId, chunk);
  }

  private lastAssistantText(session: AgentSession): string {
    const lines = session.outputBuffer.trim().split('\n');
    return lines.at(-1)?.trim() || session.outputBuffer.trim();
  }

  private async consumeRunStream(
    sessionId: string,
    session: AgentSession,
    run: Run,
    onActivity: () => void
  ): Promise<void> {
    for await (const event of run.stream()) {
      onActivity();

      switch (event.type) {
        case 'assistant': {
          for (const block of event.message.content) {
            if (block.type === 'text' && block.text) {
              this.emitChunk(sessionId, session, { text: block.text, type: 'text' });
            }
          }
          break;
        }

        case 'thinking':
          break;

        case 'tool_call': {
          if (event.status === 'running' && event.name) {
            this.emitChunk(sessionId, session, { text: event.name, type: 'tool' });
          }
          break;
        }

        case 'status': {
          const statusText = event.message || event.status;
          if (statusText) {
            this.emitChunk(sessionId, session, { text: statusText, type: 'status' });
          }
          break;
        }

        case 'task': {
          if (event.text) {
            this.emitChunk(sessionId, session, { text: `${event.text}\n`, type: 'text' });
          }
          break;
        }

        case 'request': {
          // Do not await the user here. Holding the stream applies backpressure and
          // the run never reaches wait(). Steer the reply into this run instead.
          const questionText =
            this.lastAssistantText(session) ||
            'The agent is waiting for your input.';
          logger.info(
            { sessionId, runId: run.id, requestId: event.request_id },
            'Agent requested user input'
          );
          this.emitChunk(sessionId, session, { text: questionText, type: 'status' });
          void Promise.resolve(
            this.onQuestionCallback?.(sessionId, {
              question: questionText,
              options: ['Continue'],
              requestId: event.request_id,
            })
          ).catch((err) => {
            logger.error({ err, sessionId, requestId: event.request_id }, 'Failed to surface SDK request');
          });
          break;
        }

        case 'system':
        case 'user':
          break;

        default: {
          logger.debug({ event }, 'Unhandled SDK event type');
        }
      }
    }
  }

  async closeSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    try {
      await session.agent[Symbol.asyncDispose]();
    } catch (err) {
      logger.error({ err, sessionId }, 'Error disposing agent for session');
    }

    this.sessions.delete(sessionId);
    return true;
  }

  async closeAllSessions(): Promise<number> {
    const count = this.sessions.size;

    for (const [id, session] of this.sessions) {
      try {
        await session.agent[Symbol.asyncDispose]();
      } catch (err) {
        logger.error({ err, sessionId: id }, 'Error disposing agent for session');
      }
    }

    this.sessions.clear();
    return count;
  }

  getSession(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  listSessions(): AgentSession[] {
    return Array.from(this.sessions.values());
  }

  async listAvailableModels(): Promise<Array<{ id: string; name: string }>> {
    try {
      const models = await Cursor.models.list({ apiKey: this.apiKey });
      return models.map((m) => ({ id: m.id, name: m.displayName || m.id }));
    } catch (err) {
      logger.error({ err }, 'Failed to list models');
      return [
        { id: this.defaultModel, name: this.defaultModel },
        { id: 'auto', name: 'Auto' },
      ];
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${formatDuration(ms)}`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('timed out after');
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const minutes = Math.round(ms / 60_000);
  return minutes === 1 ? '1 min' : `${minutes} min`;
}
