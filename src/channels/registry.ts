/**
 * Channel registry implementation
 */

import type { Channel, ChannelRegistry } from './base.js';

export class ChannelRegistryImpl implements ChannelRegistry {
  private channels: Map<string, Channel> = new Map();

  register(channel: Channel): void {
    this.channels.set(channel.name, channel);
  }

  get(name: string): Channel | undefined {
    return this.channels.get(name);
  }

  list(): Channel[] {
    return Array.from(this.channels.values());
  }

  async startAll(): Promise<void> {
    for (const channel of this.channels.values()) {
      await channel.start();
    }
  }

  async stopAll(): Promise<void> {
    for (const channel of this.channels.values()) {
      await channel.stop();
    }
  }
}
