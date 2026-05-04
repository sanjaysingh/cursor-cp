/**
 * Tests for configuration loader
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, mkdirSync, rmdirSync } from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { loadConfig } from './loader.js';

describe('loadConfig', () => {
  const originalEnv = process.env;
  let configPath: string;
  let tempDir: string;

  beforeEach(() => {
    tempDir = resolve(tmpdir(), `config-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    configPath = resolve(tempDir, 'test-config.yaml');
    process.env = { ...originalEnv };
    delete process.env.CURSOR_API_KEY;
    delete process.env.WORKSPACE_ROOT;
    delete process.env.CONFIG_PATH;
    delete process.env.HOST;
    delete process.env.PORT;
  });

  afterEach(() => {
    process.env = originalEnv;
    try {
      unlinkSync(configPath);
    } catch {}
    try {
      rmdirSync(tempDir);
    } catch {}
  });

  it('should load default config when file does not exist', () => {
    process.env.CONFIG_PATH = configPath;
    const { config } = loadConfig();

    expect(config.server.host).toBe('0.0.0.0');
    expect(config.server.port).toBe(8080);
    expect(config.sdk.defaultModel).toBe('composer-2');
    expect(config.sdk.maxSessions).toBe(5);
  });

  it('should load config from file', () => {
    const yaml = `
server:
  host: 127.0.0.1
  port: 3000
sdk:
  default_model: gpt-4
  max_sessions: 3
`;
    writeFileSync(configPath, yaml);
    process.env.CONFIG_PATH = configPath;

    const { config } = loadConfig();

    expect(config.server.host).toBe('127.0.0.1');
    expect(config.server.port).toBe(3000);
    expect(config.sdk.defaultModel).toBe('gpt-4');
    expect(config.sdk.maxSessions).toBe(3);
  });

  it('should use environment variables', () => {
    process.env.CURSOR_API_KEY = 'test-api-key';
    process.env.WORKSPACE_ROOT = '/custom/workspace';
    process.env.PORT = '9000';
    process.env.HOST = 'localhost';

    const { config, env } = loadConfig();

    expect(env.cursorApiKey).toBe('test-api-key');
    expect(config.workspaceRoot).toBe('/custom/workspace');
    expect(config.server.port).toBe(9000);
    expect(config.server.host).toBe('localhost');
  });

  it('should merge env over config file', () => {
    const yaml = `
server:
  port: 3000
`;
    writeFileSync(configPath, yaml);
    process.env.CONFIG_PATH = configPath;
    process.env.PORT = '5000';

    const { config } = loadConfig();

    expect(config.server.port).toBe(5000);
  });
});
