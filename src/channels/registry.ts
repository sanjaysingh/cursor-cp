/**
 * Channel registry implementation
 */

import type { Channel, ChannelRegistry } from './base.js';
import { logger } from '../util/logger.js';

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
      try {
        await channel.start();
        logger.info({ channel: channel.name }, 'Channel started');
      } catch (err) {
        logger.error({ err, channel: channel.name }, 'Channel failed to start');
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const channel of this.channels.values()) {
      try {
        await channel.stop();
        logger.info({ channel: channel.name }, 'Channel stopped');
      } catch (err) {
        logger.error({ err, channel: channel.name }, 'Channel failed to stop');
      }
    }
  }
}
