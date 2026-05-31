/**
 * Runtime paths — all project-specific files live under ~/cursor-cp/
 *
 *   ~/cursor-cp/
 *     ws-root/   agent workspace / cloned repos
 *     logs/      daily JSON logs (cursor-cp-YYYY-MM-DD.log)
 *     data/      SQLite DB, service metadata
 */

import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';
import { loadEnvFiles } from './config/env.js';

export function expandHome(path: string): string {
  const trimmed = path.trim();
  if (trimmed.startsWith('~')) {
    return resolve(trimmed.replace(/^~/, homedir()));
  }
  return resolve(trimmed);
}

/** Root directory for all cursor-cp runtime files. Override with CURSOR_CP_HOME. */
export function projectHomeDir(): string {
  const override = process.env.CURSOR_CP_HOME?.trim();
  if (override) {
    return expandHome(override);
  }
  return resolve(homedir(), 'cursor-cp');
}

/** Default repository workspace: ~/cursor-cp/ws-root */
export function defaultWorkspaceRoot(): string {
  return resolve(projectHomeDir(), 'ws-root');
}

/** Application data: ~/cursor-cp/data */
export function dataDir(): string {
  return resolve(projectHomeDir(), 'data');
}

/** Log files: ~/cursor-cp/logs */
export function logsDir(): string {
  return resolve(projectHomeDir(), 'logs');
}

/** SQLite database path. Override with CURSOR_CP_DB_PATH. */
export function databasePath(): string {
  const override = process.env.CURSOR_CP_DB_PATH?.trim();
  if (override) {
    return expandHome(override);
  }
  return resolve(dataDir(), 'cursor-cp.db');
}

/** Service install marker written by service-control / install scripts. */
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
 * Resolve active log file path.
 * - unset: default logs dir (file logging enabled)
 * - empty / false / 0: disabled
 * - otherwise: custom base path
 */
export function resolveLogFilePath(): string | null {
  loadEnvFiles();

  const raw = process.env.LOG_FILE ?? process.env.CURSOR_CP_LOG_FILE;
  if (raw === undefined) {
    return defaultLogFilePath();
  }

  const trimmed = raw.trim();
  if (!trimmed || trimmed === '0' || trimmed.toLowerCase() === 'false') {
    return null;
  }

  return expandHome(trimmed);
}
