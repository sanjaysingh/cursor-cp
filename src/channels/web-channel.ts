/**
 * Web Channel - uses EventBus for real-time communication
 */

import type { Channel } from './base.js';
import type { MessageTarget } from '../models/types.js';
import { EventBus } from '../core/events.js';

interface PendingQuestion {
  resolve: (answer: string) => void;
  reject: (reason: unknown) => void;
  options: string[];
}

export class WebChannel implements Channel {
  readonly name = 'web';

  private eventBus: EventBus;
  private pendingQuestions: Map<string, PendingQuestion> = new Map();

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  async start(): Promise<void> {
    // Web channel is always available via EventBus
  }

  async stop(): Promise<void> {
    // Reject all pending questions
    for (const [key, pending] of this.pendingQuestions) {
      pending.reject(new Error('Channel stopping'));
      this.pendingQuestions.delete(key);
    }
  }

  async sendMessage(conversationId: string, text: string): Promise<void> {
    await this.eventBus.emit({
      type: 'channel_message',
      channel: this.name,
      conversation_id: conversationId,
      text,
    });
  }

  async askQuestion(
    conversationId: string,
    question: string,
    options: string[],
    target: MessageTarget
  ): Promise<string> {
    const key = `${target.sessionId}:${conversationId}`;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingQuestions.delete(key);
        resolve(options[0] ?? '');
      }, 3600000); // 1 hour timeout

      this.pendingQuestions.set(key, {
        resolve: (answer: string) => {
          clearTimeout(timeout);
          resolve(answer);
        },
        reject: (reason: unknown) => {
          clearTimeout(timeout);
          reject(reason);
        },
        options,
      });

      // Emit question event
      this.eventBus.emit({
        type: 'question',
        channel: this.name,
        conversation_id: conversationId,
        session_id: target.sessionId,
        question,
        options,
      }).catch(() => {});
    });
  }

  submitAnswer(sessionId: string, answer: string, conversationId?: string): boolean {
    if (conversationId) {
      const key = `${sessionId}:${conversationId}`;
      const pending = this.pendingQuestions.get(key);
      if (pending) {
        pending.resolve(answer);
        this.pendingQuestions.delete(key);
        return true;
      }
      return false;
    }

    // Try to find by session prefix
    for (const [key, pending] of this.pendingQuestions) {
      if (key.startsWith(`${sessionId}:`)) {
        pending.resolve(answer);
        this.pendingQuestions.delete(key);
        return true;
      }
    }

    return false;
  }

  cancelPendingQuestion(sessionId: string): void {
    for (const [key, pending] of this.pendingQuestions) {
      if (key.startsWith(`${sessionId}:`)) {
        pending.resolve(pending.options[0] ?? '');
        this.pendingQuestions.delete(key);
      }
    }
  }
}
