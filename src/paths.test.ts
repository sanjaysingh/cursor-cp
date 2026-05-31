/**
 * Tests for runtime paths
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resolve } from 'path';
import { homedir } from 'os';
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

describe('paths', () => {
  beforeEach(() => {
    delete process.env.LOG_FILE;
    delete process.env.CURSOR_CP_LOG_FILE;
    delete process.env.CURSOR_CP_HOME;
    delete process.env.CURSOR_CP_DB_PATH;
  });

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

  it('honours CURSOR_CP_HOME override', () => {
    process.env.CURSOR_CP_HOME = '~/custom-cp';
    expect(projectHomeDir()).toBe(resolve(homedir(), 'custom-cp'));
    expect(defaultWorkspaceRoot()).toBe(resolve(homedir(), 'custom-cp', 'ws-root'));
  });

  it('disables file logging when LOG_FILE=false', () => {
    process.env.LOG_FILE = 'false';
    expect(resolveLogFilePath()).toBeNull();
  });

  it('uses custom LOG_FILE path when set', () => {
    process.env.LOG_FILE = '~/custom/app.log';
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
