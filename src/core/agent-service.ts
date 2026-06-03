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
  type SDKAgent,
} from '@cursor/sdk';
import type { AgentActivity } from '../models/types.js';
import { isWedgedActiveRunError } from '../util/agent-errors.js';
import { logger } from '../util/logger.js';

export interface AgentRunResult {
  success: boolean;
  error?: string;
  text: string;
}

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
  private onStreamCallback?: (sessionId: string, chunk: StreamChunk) => void;
  private onQuestionCallback?: (sessionId: string, question: AgentQuestion) => Promise<string>;

  constructor(options: { apiKey: string; defaultModel: string }) {
    this.apiKey = options.apiKey;
    this.defaultModel = options.defaultModel;
  }

  onStream(callback: (sessionId: string, chunk: StreamChunk) => void): void {
    this.onStreamCallback = callback;
  }

  onQuestion(callback: (sessionId: string, question: AgentQuestion) => Promise<string>): void {
    this.onQuestionCallback = callback;
  }

  async createSession(
    sessionId: string,
    workspacePath: string,
    model?: string | null
  ): Promise<AgentSession> {
    const effectiveModel = model || this.defaultModel;

    const agent = await Agent.create({
      apiKey: this.apiKey,
      model: { id: effectiveModel },
      local: {
        cwd: workspacePath,
        // Avoid loading ambient IDE settings in a headless service.
        settingSources: [],
      },
    });

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

    const agent = await Agent.resume(sdkAgentId, {
      apiKey: this.apiKey,
      model: { id: effectiveModel },
      local: {
        cwd,
        settingSources: [],
      },
    });

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
      return { success: false, error: 'Session not found', text: '' };
    }

    session.activity = 'running';
    session.outputBuffer = '';

    try {
      let followUpPrompt: string | undefined = prompt;

      while (followUpPrompt) {
        const currentPrompt = followUpPrompt;
        followUpPrompt = undefined;

        const run = await this.sendPromptToAgent(session, currentPrompt);
        logger.info(
          { sessionId, agentId: session.sdkAgentId, runId: run.id },
          'Agent run started'
        );

        const pendingAnswer = await this.consumeRunStream(sessionId, session, run);
        const result = await run.wait();

        if (pendingAnswer) {
          followUpPrompt = pendingAnswer;
          continue;
        }

        if (result.status === 'error') {
          session.activity = 'error';
          logger.error({ sessionId, runId: result.id }, 'Agent run failed');
          return {
            success: false,
            error: `Agent run failed: ${result.id}`,
            text: this.finalText(session, result.result),
          };
        }

        if (result.status === 'cancelled') {
          session.activity = 'idle';
          return {
            success: false,
            error: `Agent run cancelled: ${result.id}`,
            text: this.finalText(session, result.result),
          };
        }

        session.activity = 'idle';
        logger.info(
          { sessionId, runId: result.id, textLength: this.finalText(session, result.result).length },
          'Agent run completed'
        );
        return {
          success: true,
          text: this.finalText(session, result.result),
        };
      }

      session.activity = 'idle';
      return { success: true, text: session.outputBuffer };
    } catch (err) {
      session.activity = 'error';
      logger.error({ err, sessionId }, 'Agent sendPrompt failed');

      if (err instanceof AgentBusyError || isWedgedActiveRunError(err)) {
        return {
          success: false,
          error:
            'Agent is busy with a previous run. Close the session and start a new one, or wait for the current run to finish.',
          text: session.outputBuffer,
        };
      }

      if (err instanceof CursorAgentError) {
        return {
          success: false,
          error: `Startup failed: ${err.message} (retryable: ${err.isRetryable})`,
          text: session.outputBuffer,
        };
      }

      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        text: session.outputBuffer,
      };
    }
  }

  /**
   * Send a prompt, retrying once with local.force when the SDK store has a wedged run
   * (common after SIGTERM/restart mid-agent-run).
   */
  private async sendPromptToAgent(session: AgentSession, prompt: string): Promise<Run> {
    try {
      return await session.agent.send(prompt);
    } catch (err) {
      if (!isWedgedActiveRunError(err)) {
        throw err;
      }
      logger.warn(
        { agentId: session.sdkAgentId, sessionId: session.id },
        'Agent has wedged active run; retrying with local.force'
      );
      return await session.agent.send(prompt, { local: { force: true } });
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
    run: Run
  ): Promise<string | undefined> {
    let pendingAnswer: string | undefined;

    for await (const event of run.stream()) {
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

        case 'tool_call':
          break;

        case 'status':
          break;

        case 'task': {
          if (event.text) {
            this.emitChunk(sessionId, session, { text: `${event.text}\n`, type: 'text' });
          }
          break;
        }

        case 'request': {
          const questionText =
            this.lastAssistantText(session) ||
            'The agent needs your input to continue.';

          this.emitChunk(sessionId, session, {
            text: `\n**Input needed:** ${questionText}\n`,
            type: 'text',
          });

          if (this.onQuestionCallback) {
            try {
              const answer = await this.onQuestionCallback(sessionId, {
                question: questionText,
                options: ['Continue'],
                requestId: event.request_id,
              });
              pendingAnswer = answer;
              this.emitChunk(sessionId, session, { text: `> ${answer}\n`, type: 'text' });
            } catch (err) {
              logger.error({ err, sessionId }, 'Failed to get answer for SDK request event');
            }
          }
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

    return pendingAnswer;
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
