/**
 * Smoke test for `cursor-cp doctor`.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { writeFileSync, unlinkSync, mkdirSync, rmdirSync } from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';
import * as home from '../config/home.js';
import { resetConfigCache } from '../config/loader.js';

vi.mock('execa', () => ({
  execa: vi.fn().mockResolvedValue({ stdout: 'gh version 2.0.0' }),
}));

vi.mock('../service/service-control.js', () => ({
  ServiceController: class {
    isInstalled(): boolean {
      return false;
    }
    getStatus(): string {
      return 'unknown';
    }
  },
}));

import { runDoctor } from './doctor.js';

describe('runDoctor', () => {
  const originalExitCode = process.exitCode;
  let tempDir: string;
  let defaultPath: string;
  let overridePath: string;

  beforeEach(() => {
    tempDir = resolve(tmpdir(), `doctor-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    defaultPath = resolve(tempDir, 'config.default.yaml');
    overridePath = resolve(tempDir, 'config.yaml');
    writeFileSync(defaultPath, 'server:\n  port: 8747\n');
    writeFileSync(overridePath, 'cursor:\n  api_key: cursor_test_key\n');

    vi.spyOn(home, 'configDefaultPath').mockReturnValue(defaultPath);
    vi.spyOn(home, 'userConfigPath').mockReturnValue(overridePath);
    vi.spyOn(home, 'projectConfigPath').mockReturnValue(resolve(tempDir, 'missing.yaml'));
    resetConfigCache();
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
    resetConfigCache();
    for (const path of [defaultPath, overridePath]) {
      try {
        unlinkSync(path);
      } catch { /* ignore */ }
    }
    try {
      rmdirSync(tempDir);
    } catch { /* ignore */ }
  });

  it('runs all checks without throwing', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runDoctor()).resolves.toBeUndefined();
  });
});
