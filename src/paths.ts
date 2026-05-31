/**
 * Runtime paths — project data under ~/cursor-cp/
 */

import { existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import {
  expandHome,
  projectHomeDir,
  defaultWorkspaceRoot,
} from './config/home.js';
import { getLoadedConfig } from './config/loader.js';

export { expandHome, projectHomeDir, defaultWorkspaceRoot };

/** Application data: ~/cursor-cp/data */
export function dataDir(): string {
  return resolve(projectHomeDir(), 'data');
}

/** Log files: ~/cursor-cp/logs */
export function logsDir(): string {
  return resolve(projectHomeDir(), 'logs');
}

/** SQLite database path. */
export function databasePath(): string {
  return resolve(dataDir(), 'cursor-cp.db');
}

/** Daemon install marker written by service-control. */
export function serviceMarkerPath(): string {
  return resolve(dataDir(), 'service.json');
}

/** Base log path used for daily rotation (cursor-cp-YYYY-MM-DD.log). */
export function defaultLogFilePath(): string {
  return resolve(logsDir(), 'cursor-cp.log');
}

/** Create project home, workspace, data, and logs directories if missing. */
export function ensureProjectDirs(): void {
  for (const dir of [projectHomeDir(), defaultWorkspaceRoot(), dataDir(), logsDir()]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

/**
 * Resolve active log file path from loaded config.
 * - null/undefined file setting: default logs dir (file logging enabled)
 * - empty / false: disabled
 * - otherwise: custom base path
 */
export function resolveLogFilePath(): string | null {
  const fileSetting = getLoadedConfig()?.logging.file;

  if (fileSetting === undefined || fileSetting === null) {
    return defaultLogFilePath();
  }

  const trimmed = fileSetting.trim();
  if (!trimmed || trimmed === '0' || trimmed.toLowerCase() === 'false') {
    return null;
  }

  return expandHome(trimmed);
}
