/**
 * Tests for WebChannel
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WebChannel } from './web-channel.js';
import { EventBus } from '../core/events.js';

describe('WebChannel', () => {
  let channel: WebChannel;
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
    channel = new WebChannel(eventBus);
  });

  it('should have correct name', () => {
    expect(channel.name).toBe('web');
  });

  it('should send messages via event bus', async () => {
    let received: Record<string, unknown> | null = null;

    eventBus.on('channel_message', (event) => {
      received = event;
    });

    await channel.sendMessage('conv-1', 'Hello world');

    expect(received).toBeDefined();
    expect(received?.type).toBe('channel_message');
    expect(received?.channel).toBe('web');
    expect(received?.conversationId).toBe('conv-1');
    expect(received?.text).toBe('Hello world');
  });

  it('should submit answer to pending question', async () => {
    const target = { sessionId: 's1', conversationId: 'c1' };

    // Start asking a question
    const askPromise = channel.askQuestion('c1', 'What?', ['A', 'B'], target);

    // Submit answer
    const submitted = channel.submitAnswer('s1', 'A', 'c1');
    expect(submitted).toBe(true);

    const answer = await askPromise;
    expect(answer).toBe('A');
  });

  it('should return false for nonexistent question', () => {
    const submitted = channel.submitAnswer('s1', 'A');
    expect(submitted).toBe(false);
  });

  it('should cancel pending questions', async () => {
    const target = { sessionId: 's1', conversationId: 'c1' };

    // Start asking
    const askPromise = channel.askQuestion('c1', 'What?', ['A', 'B'], target);

    // Cancel
    channel.cancelPendingQuestion('s1');

    const answer = await askPromise;
    expect(answer).toBe('A'); // Returns first option on cancel
  });
});
