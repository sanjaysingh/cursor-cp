/**
 * Event bus for pub/sub communication
 */

import type { AppEvent } from '../models/types.js';
import { logger } from '../util/logger.js';

export type EventHandler = (event: AppEvent) => void | Promise<void>;

export class EventBus {
  private handlers: Map<string, Set<EventHandler>> = new Map();

  on(eventType: string, handler: EventHandler): () => void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    this.handlers.get(eventType)!.add(handler);

    return () => this.off(eventType, handler);
  }

  off(eventType: string, handler: EventHandler): void {
    this.handlers.get(eventType)?.delete(handler);
  }

  async emit(event: AppEvent): Promise<void> {
    await this.invokeHandlers(event.type, event);

    if ((event.type as string) !== '*') {
      await this.invokeHandlers('*', event);
    }
  }

  private async invokeHandlers(eventType: string, event: AppEvent): Promise<void> {
    const handlers = this.handlers.get(eventType);
    if (!handlers) return;

    const promises: Promise<void>[] = [];
    for (const handler of handlers) {
      try {
        const result = handler(event);
        if (result instanceof Promise) {
          promises.push(result);
        }
      } catch (err) {
        logger.error({ err, eventType }, 'Event handler failed');
      }
    }

    if (promises.length > 0) {
      await Promise.all(promises);
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}

export const globalEventBus = new EventBus();
