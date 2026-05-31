/**
 * Tests for the setup wizard's pure helpers.
 */

import { describe, it, expect } from 'vitest';
import {
  validateApiKey,
  parseAllowedUserIds,
  buildConfigObject,
  parseSetupArgs,
  type SetupValues,
} from './setup.js';

interface ConfigShape {
  cursor: { api_key: string };
  repos: unknown[];
  workspace_root?: string;
  server: { host: string; port: number };
  sdk: { default_model: string; max_sessions: number };
  logging: { level: string };
  channels: {
    telegram: { enabled: boolean; bot_token: string; allowed_user_ids: number[] };
    web: { enabled: boolean };
  };
}

const baseValues: SetupValues = {
  apiKey: 'cursor_abc123',
  defaultModel: 'composer-2.5',
  host: '0.0.0.0',
  port: 8747,
  logLevel: 'info',
  telegram: { enabled: false, token: '', allowedIds: '' },
};

describe('validateApiKey', () => {
  it('rejects empty and placeholder keys', () => {
    expect(validateApiKey('').ok).toBe(false);
    expect(validateApiKey('your_key_here').ok).toBe(false);
  });

  it('accepts any non-empty, non-placeholder key', () => {
    expect(validateApiKey('cursor_abc').ok).toBe(true);
    expect(validateApiKey('crsr_abc123').ok).toBe(true);
  });
});

describe('parseAllowedUserIds', () => {
  it('parses comma and space separated ids', () => {
    expect(parseAllowedUserIds('1, 2 3')).toEqual([1, 2, 3]);
  });
});

describe('buildConfigObject', () => {
  it('produces a full config from nothing', () => {
    const cfg = buildConfigObject(undefined, baseValues) as unknown as ConfigShape;
    expect(cfg.cursor.api_key).toBe('cursor_abc123');
    expect(cfg.server).toEqual({ host: '0.0.0.0', port: 8747 });
    expect(cfg.sdk.default_model).toBe('composer-2.5');
    expect(cfg.channels.telegram.enabled).toBe(false);
    expect(cfg.channels.telegram.bot_token).toBe('');
    expect(cfg.logging.level).toBe('info');
  });

  it('includes telegram token and ids when enabled', () => {
    const cfg = buildConfigObject(undefined, {
      ...baseValues,
      telegram: { enabled: true, token: 'tok123', allowedIds: '1,2' },
    }) as unknown as ConfigShape;

    expect(cfg.channels.telegram.enabled).toBe(true);
    expect(cfg.channels.telegram.bot_token).toBe('tok123');
    expect(cfg.channels.telegram.allowed_user_ids).toEqual([1, 2]);
  });

  it('preserves repos, workspace_root, max_sessions and web toggle', () => {
    const existing = {
      repos: [{ name: 'x', path: '/p', description: '' }],
      workspace_root: '/ws',
      sdk: { default_model: 'old', max_sessions: 9 },
      channels: { web: { enabled: false }, telegram: { enabled: false } },
    };
    const cfg = buildConfigObject(existing, baseValues) as unknown as ConfigShape;

    expect(cfg.repos).toEqual(existing.repos);
    expect(cfg.sdk.max_sessions).toBe(9);
    expect(cfg.channels.web.enabled).toBe(false);
  });
});

describe('parseSetupArgs', () => {
  it('parses daemon flags', () => {
    expect(parseSetupArgs(['--enable-daemon']).enableDaemon).toBe(true);
    expect(parseSetupArgs(['--no-daemon']).noDaemon).toBe(true);
  });
});
