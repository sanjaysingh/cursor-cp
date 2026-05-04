/**
 * Tests for ChannelRegistry
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ChannelRegistryImpl } from './registry.js';
import type { Channel, MessageTarget } from './base.js';

class MockChannel implements Channel {
  name: string;
  start = vi.fn().mockResolvedValue(undefined);
  stop = vi.fn().mockResolvedValue(undefined);
  sendMessage = vi.fn().mockResolvedValue(undefined);
  askQuestion = vi.fn().mockResolvedValue('answer');

  constructor(name: string) {
    this.name = name;
  }
}

describe('ChannelRegistryImpl', () => {
  let registry: ChannelRegistryImpl;

  beforeEach(() => {
    registry = new ChannelRegistryImpl();
  });

  it('should register and get channels', () => {
    const channel = new MockChannel('test');

    registry.register(channel);

    expect(registry.get('test')).toBe(channel);
    expect(registry.get('missing')).toBeUndefined();
  });

  it('should list all channels', () => {
    const channel1 = new MockChannel('c1');
    const channel2 = new MockChannel('c2');

    registry.register(channel1);
    registry.register(channel2);

    const list = registry.list();
    expect(list).toHaveLength(2);
    expect(list).toContain(channel1);
    expect(list).toContain(channel2);
  });

  it('should start all channels', async () => {
    const channel1 = new MockChannel('c1');
    const channel2 = new MockChannel('c2');

    registry.register(channel1);
    registry.register(channel2);

    await registry.startAll();

    expect(channel1.start).toHaveBeenCalled();
    expect(channel2.start).toHaveBeenCalled();
  });

  it('should stop all channels', async () => {
    const channel1 = new MockChannel('c1');
    const channel2 = new MockChannel('c2');

    registry.register(channel1);
    registry.register(channel2);

    await registry.stopAll();

    expect(channel1.stop).toHaveBeenCalled();
    expect(channel2.stop).toHaveBeenCalled();
  });
});
