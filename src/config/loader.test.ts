/**
 * Tests for configuration loader
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, mkdirSync, rmdirSync } from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { deepMerge, loadConfigFromPaths } from './loader.js';
import { defaultWorkspaceRoot } from '../paths.js';

describe('deepMerge', () => {
  it('merges nested objects and replaces scalars', () => {
    const base = { server: { host: '0.0.0.0', port: 8747 }, cursor: { api_key: '' } };
    const override = { cursor: { api_key: 'cursor_abc' }, server: { port: 9000 } };
    const merged = deepMerge(base, override);
    expect(merged).toEqual({
      server: { host: '0.0.0.0', port: 9000 },
      cursor: { api_key: 'cursor_abc' },
    });
  });
});

describe('loadConfigFromPaths', () => {
  let tempDir: string;
  let defaultPath: string;
  let overridePath: string;

  beforeEach(() => {
    tempDir = resolve(tmpdir(), `config-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    defaultPath = resolve(tempDir, 'config.default.yaml');
    overridePath = resolve(tempDir, 'config.yaml');
  });

  afterEach(() => {
    for (const path of [defaultPath, overridePath]) {
      try {
        unlinkSync(path);
      } catch { /* ignore */ }
    }
    try {
      rmdirSync(tempDir);
    } catch { /* ignore */ }
  });

  it('loads defaults when no override exists', () => {
    writeFileSync(defaultPath, 'server:\n  port: 8747\n');
    const { config } = loadConfigFromPaths(defaultPath, [overridePath]);
    expect(config.server.port).toBe(8747);
    expect(config.workspaceRoot).toBe(defaultWorkspaceRoot());
  });

  it('merges override onto defaults', () => {
    writeFileSync(defaultPath, 'server:\n  host: 0.0.0.0\n  port: 8747\nsdk:\n  default_model: composer-2.5\n');
    writeFileSync(
      overridePath,
      `cursor:\n  api_key: file-key\nserver:\n  port: 3000\nchannels:\n  telegram:\n    bot_token: tok\n    allowed_user_ids: [1]\n`
    );

    const { config, overridePaths } = loadConfigFromPaths(defaultPath, [overridePath]);

    expect(overridePaths).toEqual([overridePath]);
    expect(config.cursorApiKey).toBe('file-key');
    expect(config.server.host).toBe('0.0.0.0');
    expect(config.server.port).toBe(3000);
    expect(config.sdk.defaultModel).toBe('composer-2.5');
    expect(config.channels.telegram.botToken).toBe('tok');
    expect(config.channels.telegram.allowedUserIds).toEqual([1]);
  });
});
