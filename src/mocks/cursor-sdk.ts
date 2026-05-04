/**
 * Mock implementation of @cursor/sdk for testing
 * Remove this when the real SDK is available
 */

export interface Model {
  id: string;
  name?: string;
}

export interface AgentOptions {
  apiKey: string;
  model: { id: string };
  local?: { cwd: string };
  cloud?: {
    repos?: Array<{ url: string }>;
    autoCreatePR?: boolean;
  };
}

export interface StreamEvent {
  type: 'assistant' | 'tool' | 'error' | 'question';
  message?: {
    content: Array<{ type: 'text'; text: string }>;
  };
  // Question event fields
  question?: string;
  options?: string[];
  // Tool event fields
  tool?: {
    name: string;
  };
}

export interface RunResult {
  status: 'finished' | 'error' | 'cancelled';
  id: string;
}

export interface AgentRun {
  stream(): AsyncIterableIterator<StreamEvent>;
  wait(): Promise<RunResult>;
}

export class Agent {
  private options: AgentOptions;
  private disposed = false;

  static models = {
    async list(opts: { apiKey: string }): Promise<Model[]> {
      // Return mock models
      return [
        { id: 'composer-2', name: 'Composer 2' },
        { id: 'composer-1', name: 'Composer 1' },
        { id: 'auto', name: 'Auto' },
      ];
    },
  };

  static create(options: AgentOptions): Agent {
    return new Agent(options);
  }

  constructor(options: AgentOptions) {
    this.options = options;
  }

  async send(prompt: string): Promise<AgentRun> {
    if (this.disposed) {
      throw new Error('Agent has been disposed');
    }

    const mockResponse = `Mock response for: ${prompt.slice(0, 50)}...`;

    return {
      async *stream(): AsyncIterableIterator<StreamEvent> {
        // Simulate streaming chunks
        const words = mockResponse.split(' ');
        for (const word of words) {
          yield {
            type: 'assistant',
            message: {
              content: [{ type: 'text', text: word + ' ' }],
            },
          };
          // Small delay to simulate real streaming
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
      },
      async wait(): Promise<RunResult> {
        return { status: 'finished', id: 'mock-run-id' };
      },
    };
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.disposed = true;
  }
}

export class CursorAgentError extends Error {
  isRetryable: boolean;

  constructor(message: string, isRetryable = false) {
    super(message);
    this.name = 'CursorAgentError';
    this.isRetryable = isRetryable;
  }
}
