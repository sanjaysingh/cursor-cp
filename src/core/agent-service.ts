/**
 * Cursor SDK Agent Service
 * Manages agent lifecycle using the official @cursor/sdk
 */

import {
  Agent,
  Cursor,
  CursorAgentError,
  type Run,
  type SDKAgent,
} from '@cursor/sdk';
import type { AgentActivity } from '../models/types.js';

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

        const run = await session.agent.send(currentPrompt);
        console.debug(
          `Agent run started: session=${sessionId} agent=${session.sdkAgentId} run=${run.id}`
        );

        const pendingAnswer = await this.consumeRunStream(sessionId, session, run);
        const result = await run.wait();

        if (pendingAnswer) {
          followUpPrompt = pendingAnswer;
          continue;
        }

        if (result.status === 'error') {
          session.activity = 'error';
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
        return {
          success: true,
          text: this.finalText(session, result.result),
        };
      }

      session.activity = 'idle';
      return { success: true, text: session.outputBuffer };
    } catch (err) {
      session.activity = 'error';

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
            } else if (block.type === 'tool_use') {
              this.emitChunk(sessionId, session, {
                text: `🔧 Tool requested: ${block.name}\n`,
                type: 'tool',
              });
            }
          }
          break;
        }

        case 'thinking': {
          if (event.text) {
            this.emitChunk(sessionId, session, { text: event.text, type: 'thinking' });
          }
          break;
        }

        case 'tool_call': {
          const statusSuffix =
            event.status === 'completed'
              ? ' completed'
              : event.status === 'error'
                ? ' failed'
                : ' started';
          this.emitChunk(sessionId, session, {
            text: `🔧 ${event.name}${statusSuffix}\n`,
            type: 'tool',
          });
          break;
        }

        case 'status': {
          if (event.message) {
            this.emitChunk(sessionId, session, {
              text: `[${event.status}] ${event.message}\n`,
              type: 'status',
            });
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
              console.error('Failed to get answer for SDK request event:', err);
            }
          }
          break;
        }

        case 'system':
        case 'user':
          break;

        default: {
          console.debug('Unhandled SDK event type:', event);
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
      console.error(`Error disposing agent for session ${sessionId}:`, err);
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
        console.error(`Error disposing agent for session ${id}:`, err);
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
      console.error('Failed to list models:', err);
      return [
        { id: this.defaultModel, name: this.defaultModel },
        { id: 'auto', name: 'Auto' },
      ];
    }
  }
}
