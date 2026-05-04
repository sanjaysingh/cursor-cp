/**
 * Tests for TelegramChannel exports
 *
 * Note: Full integration tests for TelegramChannel are covered by E2E tests.
 * Testing the Telegraf bot requires complex mocking that's better handled
 * at the integration level.
 */

import { describe, it, expect } from 'vitest';

describe('TelegramChannel', () => {
  it('should export TelegramChannel class', async () => {
    const { TelegramChannel } = await import('./telegram-channel.js');
    expect(TelegramChannel).toBeDefined();
    expect(typeof TelegramChannel).toBe('function');
  });

  it('should have required methods on prototype', async () => {
    const { TelegramChannel } = await import('./telegram-channel.js');
    expect(typeof TelegramChannel.prototype.start).toBe('function');
    expect(typeof TelegramChannel.prototype.stop).toBe('function');
    expect(typeof TelegramChannel.prototype.sendMessage).toBe('function');
    expect(typeof TelegramChannel.prototype.askQuestion).toBe('function');
  });
});
