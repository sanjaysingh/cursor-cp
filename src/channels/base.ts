/**
 * Base channel interface
 */

import type { MessageTarget } from '../models/types.js';

export interface Channel {
  readonly name: string;

  start(): Promise<void>;
  stop(): Promise<void>;

  /**
   * Send plain text message to a conversation
   */
  sendMessage(conversationId: string, text: string): Promise<void>;

  /**
   * Ask a question and wait for answer
   * @returns The selected option or typed answer
   */
  askQuestion(
    conversationId: string,
    question: string,
    options: string[],
    target: MessageTarget
  ): Promise<string>;
}

export interface ChannelRegistry {
  register(channel: Channel): void;
  get(name: string): Channel | undefined;
  list(): Channel[];
  startAll(): Promise<void>;
  stopAll(): Promise<void>;
}
