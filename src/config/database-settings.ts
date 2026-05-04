/**
 * Database-backed Settings Integration
 * Allows runtime configuration changes via API
 */

import type { SettingsRepository } from '../db/repositories.js';

export const DB_SETTINGS_KEYS = {
  DEFAULT_MODEL: 'default_model',
  TELEGRAM_BOT_TOKEN: 'telegram_bot_token',
  TELEGRAM_ALLOWED_USERS: 'telegram_allowed_users',
  TELEGRAM_ENABLED: 'telegram_enabled',
  WEB_ENABLED: 'web_enabled',
  SERVER_HOST: 'server_host',
  SERVER_PORT: 'server_port',
  WORKSPACE_ROOT: 'workspace_root',
} as const;

export type DbSettingKey = (typeof DB_SETTINGS_KEYS)[keyof typeof DB_SETTINGS_KEYS];

export class DatabaseSettings {
  constructor(private repository: SettingsRepository) {}

  async get(key: DbSettingKey): Promise<string | undefined> {
    return this.repository.get(key);
  }

  async set(key: DbSettingKey, value: string): Promise<void> {
    this.repository.set(key, value);
  }

  async delete(key: DbSettingKey): Promise<void> {
    this.repository.delete(key);
  }

  async getDefaultModel(): Promise<string | undefined> {
    return this.get(DB_SETTINGS_KEYS.DEFAULT_MODEL);
  }

  async setDefaultModel(model: string): Promise<void> {
    await this.set(DB_SETTINGS_KEYS.DEFAULT_MODEL, model);
  }

  async isTelegramEnabled(): Promise<boolean> {
    const value = await this.get(DB_SETTINGS_KEYS.TELEGRAM_ENABLED);
    return value === 'true';
  }

  async setTelegramEnabled(enabled: boolean): Promise<void> {
    await this.set(DB_SETTINGS_KEYS.TELEGRAM_ENABLED, enabled ? 'true' : 'false');
  }

  async isWebEnabled(): Promise<boolean> {
    const value = await this.get(DB_SETTINGS_KEYS.WEB_ENABLED);
    return value !== 'false'; // Default to true
  }

  async setWebEnabled(enabled: boolean): Promise<void> {
    await this.set(DB_SETTINGS_KEYS.WEB_ENABLED, enabled ? 'true' : 'false');
  }

  async getServerHost(): Promise<string | undefined> {
    return this.get(DB_SETTINGS_KEYS.SERVER_HOST);
  }

  async setServerHost(host: string): Promise<void> {
    await this.set(DB_SETTINGS_KEYS.SERVER_HOST, host);
  }

  async getServerPort(): Promise<number | undefined> {
    const value = await this.get(DB_SETTINGS_KEYS.SERVER_PORT);
    return value ? parseInt(value, 10) : undefined;
  }

  async setServerPort(port: number): Promise<void> {
    await this.set(DB_SETTINGS_KEYS.SERVER_PORT, String(port));
  }

  async getAll(): Promise<Record<string, string>> {
    const all: Record<string, string> = {};

    for (const key of Object.values(DB_SETTINGS_KEYS)) {
      const value = this.repository.get(key);
      if (value !== undefined) {
        all[key] = value;
      }
    }

    return all;
  }
}
