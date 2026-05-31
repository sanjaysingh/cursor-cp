/**
 * Configuration path helpers.
 *
 *   config.default.yaml   shipped defaults (committed, in the install / source tree)
 *   config.yaml           your overrides (not committed; chmod 600 when it has secrets)
 *
 * Runtime data lives under ~/cursor-cp/ (ws-root, logs, data).
 */

import { homedir } from 'os';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

/** Resolve a path, expanding a leading `~` to the user's home directory. */
export function expandHome(path: string): string {
  const trimmed = path.trim();
  if (trimmed.startsWith('~')) {
    return resolve(trimmed.replace(/^~/, homedir()));
  }
  return resolve(trimmed);
}

/** Root directory for cursor-cp runtime data. */
export function projectHomeDir(): string {
  return resolve(homedir(), 'cursor-cp');
}

/** Default repository workspace: ~/cursor-cp/ws-root */
export function defaultWorkspaceRoot(): string {
  return resolve(projectHomeDir(), 'ws-root');
}

/** Install or source-tree root (where config.default.yaml lives). */
export function getProjectRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../..');
}

/** Shipped defaults: <install-dir>/config.default.yaml */
export function configDefaultPath(): string {
  return resolve(getProjectRoot(), 'config.default.yaml');
}

/** User overrides when running from source: <project>/config.yaml */
export function projectConfigPath(): string {
  return resolve(getProjectRoot(), 'config.yaml');
}

/** User overrides for installed instances: ~/cursor-cp/config.yaml */
export function userConfigPath(): string {
  return resolve(projectHomeDir(), 'config.yaml');
}
