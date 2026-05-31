/**
 * Tests for EventBus
 */

import { describe, it, expect, vi } from 'vitest';
import { EventBus } from './events.js';

describe('EventBus', () => {
  it('should subscribe and emit events', async () => {
    const bus = new EventBus();
    const handler = vi.fn();

    bus.on('test_event', handler);
    await bus.emit({ type: 'test_event', data: 'hello' });

    expect(handler).toHaveBeenCalledWith({ type: 'test_event', data: 'hello' });
  });

  it('should allow unsubscribing', async () => {
    const bus = new EventBus();
    const handler = vi.fn();

    const unsubscribe = bus.on('test_event', handler);
    unsubscribe();

    await bus.emit({ type: 'test_event', data: 'hello' });

    expect(handler).not.toHaveBeenCalled();
  });

  it('should handle multiple subscribers', async () => {
    const bus = new EventBus();
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    bus.on('test_event', handler1);
    bus.on('test_event', handler2);

    await bus.emit({ type: 'test_event' });

    expect(handler1).toHaveBeenCalled();
    expect(handler2).toHaveBeenCalled();
  });

  it('should handle async handlers', async () => {
    const bus = new EventBus();
    const results: string[] = [];

    bus.on('test_event', async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      results.push('async1');
    });

    bus.on('test_event', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      results.push('async2');
    });

    await bus.emit({ type: 'test_event' });

    expect(results).toContain('async1');
    expect(results).toContain('async2');
  });

  it('should not break on handler errors', async () => {
    const bus = new EventBus();
    const errorHandler = vi.fn(() => {
      throw new Error('Test error');
    });
    const successHandler = vi.fn();

    bus.on('test_event', errorHandler);
    bus.on('test_event', successHandler);

    // Should not throw
    await bus.emit({ type: 'test_event' });

    expect(errorHandler).toHaveBeenCalled();
    expect(successHandler).toHaveBeenCalled();
  });

  it('should clear all handlers', async () => {
    const bus = new EventBus();
    const handler = vi.fn();

    bus.on('test_event', handler);
    bus.clear();

    await bus.emit({ type: 'test_event' });

    expect(handler).not.toHaveBeenCalled();
  });

  it('should invoke wildcard handlers for all events', async () => {
    const bus = new EventBus();
    const wildcard = vi.fn();
    const specific = vi.fn();

    bus.on('*', wildcard);
    bus.on('agent_stream', specific);

    await bus.emit({ type: 'agent_stream', session_id: 's1', text: 'hi' });

    expect(wildcard).toHaveBeenCalledWith({
      type: 'agent_stream',
      session_id: 's1',
      text: 'hi',
    });
    expect(specific).toHaveBeenCalledWith({
      type: 'agent_stream',
      session_id: 's1',
      text: 'hi',
    });
  });
});
