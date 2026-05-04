/**
 * Cursor SDK Agent Service
 * Manages agent lifecycle using the official @cursor/sdk
 */

// TODO: Replace with actual SDK when available
import { Agent, type CursorAgentError } from '../mocks/cursor-sdk.js';
import type { AgentActivity } from '../models/types.js';

export interface AgentRunResult {
  success: boolean;
  error?: string;
  text: string;
}

export interface AgentSession {
  id: string;
  agent: Agent;
  model: string;
  workspacePath: string;
  activity: AgentActivity;
  outputBuffer: string;
  createdAt: Date;
}

interface StreamChunk {
  text: string;
  type: 'text' | 'tool' | 'error';
}

export interface AgentQuestion {
  question: string;
  options: string[];
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

    // Create SDK agent with local runtime
    const agent = Agent.create({
      apiKey: this.apiKey,
      model: { id: effectiveModel },
      local: { cwd: workspacePath },
    });

    const session: AgentSession = {
      id: sessionId,
      agent,
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
      const run = await session.agent.send(prompt);

      // Stream the response
      for await (const event of run.stream()) {
        // Handle different event types from SDK
        switch (event.type) {
          case 'assistant': {
            // Regular text output from agent
            for (const block of event.message.content) {
              if (block.type === 'text' && block.text) {
                const chunk: StreamChunk = { text: block.text, type: 'text' };
                session.outputBuffer += block.text;
                this.onStreamCallback?.(sessionId, chunk);
              }
            }
            break;
          }

          case 'question': {
            // Agent is asking a question - this is the critical fix
            // Extract question text and options properly
            const questionText = event.question || 'Please choose:';
            const options = event.options || ['OK'];

            // Stream the question text to UI first (so user sees context)
            const questionChunk: StreamChunk = {
              text: `**${questionText}**`,
              type: 'text',
            };
            session.outputBuffer += questionText + '\n';
            this.onStreamCallback?.(sessionId, questionChunk);

            // If we have a question handler, use it
            if (this.onQuestionCallback) {
              try {
                const answer = await this.onQuestionCallback(sessionId, {
                  question: questionText,
                  options,
                });

                // Send the answer back to the agent
                // Note: The SDK may handle this differently - we might need
                // to send the answer through a different mechanism
                session.outputBuffer += `> ${answer}\n`;
              } catch (err) {
                console.error('Failed to get answer for question:', err);
                // Default to first option
                session.outputBuffer += `> ${options[0]}\n`;
              }
            }
            break;
          }

          case 'tool': {
            // Tool call event - could show to user for transparency
            if (event.tool) {
              const toolText = `🔧 Using tool: ${event.tool.name}\n`;
              const chunk: StreamChunk = { text: toolText, type: 'tool' };
              this.onStreamCallback?.(sessionId, chunk);
            }
            break;
          }

          case 'error': {
            // Error event from stream
            const errorText = event.message || 'An error occurred';
            const chunk: StreamChunk = { text: `❌ ${errorText}\n`, type: 'error' };
            this.onStreamCallback?.(sessionId, chunk);
            break;
          }

          default: {
            // Unknown event type - log for debugging
            console.debug('Unknown SDK event type:', event.type, event);
          }
        }
      }

      // Wait for completion and get result
      const result = await run.wait();

      if (result.status === 'error') {
        session.activity = 'error';
        return {
          success: false,
          error: `Agent run failed: ${result.id}`,
          text: session.outputBuffer,
        };
      }

      session.activity = 'idle';
      return {
        success: true,
        text: session.outputBuffer,
      };
    } catch (err) {
      const error = err as CursorAgentError;
      session.activity = 'error';

      // Check if it's a startup failure (auth, config, network)
      if (error instanceof Error && error.name === 'CursorAgentError') {
        const cae = error as CursorAgentError;
        return {
          success: false,
          error: `Startup failed: ${cae.message} (retryable: ${cae.isRetryable})`,
          text: session.outputBuffer,
        };
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        text: session.outputBuffer,
      };
    }
  }

  async closeSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    try {
      // Properly dispose of the agent
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
      const models = await Agent.models.list({ apiKey: this.apiKey });
      return models.map((m) => ({ id: m.id, name: m.name ?? m.id }));
    } catch (err) {
      console.error('Failed to list models:', err);
      // Return default models as fallback
      return [
        { id: 'composer-2', name: 'composer-2' },
        { id: 'auto', name: 'Auto' },
      ];
    }
  }
}
