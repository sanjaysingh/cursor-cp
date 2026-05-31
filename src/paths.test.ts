/**
 * Tests for runtime paths
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, mkdirSync, rmdirSync } from 'fs';
import { resolve } from 'path';
import { homedir, tmpdir } from 'os';
import { dailyLogPath, LOG_RETENTION_DAYS } from './util/daily-log-stream.js';
import {
  dataDir,
  defaultLogFilePath,
  defaultWorkspaceRoot,
  expandHome,
  logsDir,
  projectHomeDir,
  resolveLogFilePath,
} from './paths.js';
import { loadConfigFromPaths } from './config/loader.js';

describe('paths', () => {
  it('expands home in paths', () => {
    expect(expandHome('~/tmp/logs/app.log')).toBe(resolve(homedir(), 'tmp/logs/app.log'));
  });

  it('uses ~/cursor-cp as project home', () => {
    expect(projectHomeDir()).toBe(resolve(homedir(), 'cursor-cp'));
  });

  it('places workspace, data, and logs under project home', () => {
    const home = projectHomeDir();
    expect(defaultWorkspaceRoot()).toBe(resolve(home, 'ws-root'));
    expect(dataDir()).toBe(resolve(home, 'data'));
    expect(logsDir()).toBe(resolve(home, 'logs'));
    expect(defaultLogFilePath()).toBe(resolve(home, 'logs', 'cursor-cp.log'));
  });
});

describe('resolveLogFilePath', () => {
  let tempDir: string;
  let defaultPath: string;
  let overridePath: string;

  beforeEach(() => {
    tempDir = resolve(tmpdir(), `paths-log-test-${Date.now()}`);
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

  it('uses default log path when logging.file is unset', () => {
    writeFileSync(defaultPath, 'logging:\n  level: info\n');
    loadConfigFromPaths(defaultPath, []);
    expect(resolveLogFilePath()).toBe(defaultLogFilePath());
  });

  it('disables file logging when logging.file is false', () => {
    writeFileSync(defaultPath, 'logging:\n  level: info\n');
    writeFileSync(overridePath, 'logging:\n  file: false\n');
    loadConfigFromPaths(defaultPath, [overridePath]);
    expect(resolveLogFilePath()).toBeNull();
  });

  it('uses custom logging.file path when set', () => {
    writeFileSync(defaultPath, 'logging:\n  level: info\n');
    writeFileSync(overridePath, 'logging:\n  file: ~/custom/app.log\n');
    loadConfigFromPaths(defaultPath, [overridePath]);
    expect(resolveLogFilePath()).toBe(resolve(homedir(), 'custom/app.log'));
  });
});

describe('dailyLogPath', () => {
  it('appends date before extension', () => {
    expect(dailyLogPath('/var/log/cursor-cp.log', new Date('2026-05-30T12:00:00')))
      .toMatch(/cursor-cp-2026-05-30\.log$/);
  });

  it('uses 7-day retention constant', () => {
    expect(LOG_RETENTION_DAYS).toBe(7);
  });
});
