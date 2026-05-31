/**
 * Daily log file stream with retention (mirrors Python DailyFileHandler).
 */

import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  type WriteStream,
} from 'fs';
import { dirname, resolve } from 'path';
import { Writable } from 'stream';

export const LOG_RETENTION_DAYS = 7;

function formatDay(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Turn `cursor-cp.log` into `cursor-cp-2026-05-30.log`. */
export function dailyLogPath(basePath: string, day: Date): string {
  const resolved = resolve(basePath);
  const lastSlash = Math.max(resolved.lastIndexOf('/'), resolved.lastIndexOf('\\'));
  const lastDot = resolved.lastIndexOf('.');

  if (lastDot > lastSlash) {
    return `${resolved.slice(0, lastDot)}-${formatDay(day)}${resolved.slice(lastDot)}`;
  }

  return `${resolved}-${formatDay(day)}`;
}

function isManagedDailyLog(basePath: string, candidateName: string): boolean {
  const resolved = resolve(basePath);
  const fileName = resolved.slice(Math.max(resolved.lastIndexOf('/'), resolved.lastIndexOf('\\')) + 1);
  const lastDot = fileName.lastIndexOf('.');
  const stem = lastDot >= 0 ? fileName.slice(0, lastDot) : fileName;
  const suffix = lastDot >= 0 ? fileName.slice(lastDot) : '';

  if (!candidateName.startsWith(`${stem}-`)) {
    return false;
  }
  if (suffix) {
    return candidateName.endsWith(suffix);
  }
  return true;
}

function pruneOldLogs(basePath: string, now: Date, retentionDays: number): void {
  const dir = dirname(resolve(basePath));
  if (!existsSync(dir)) {
    return;
  }

  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;

  for (const name of readdirSync(dir)) {
    if (!isManagedDailyLog(basePath, name)) {
      continue;
    }

    const fullPath = resolve(dir, name);
    try {
      if (statSync(fullPath).mtimeMs < cutoff) {
        unlinkSync(fullPath);
      }
    } catch {
      // Ignore races while pruning.
    }
  }
}

export class DailyLogStream extends Writable {
  private basePath: string;
  private retentionDays: number;
  private currentDay: string | null = null;
  private lastCleanupDay: string | null = null;
  private fileStream: WriteStream | null = null;

  constructor(basePath: string, retentionDays = LOG_RETENTION_DAYS) {
    super();
    this.basePath = resolve(basePath);
    this.retentionDays = retentionDays;
    mkdirSync(dirname(this.basePath), { recursive: true });
    this.ensureStream(new Date());
    this.cleanupOldLogs(new Date());
  }

  private ensureStream(now: Date): void {
    const day = formatDay(now);
    if (this.currentDay === day && this.fileStream) {
      return;
    }

    this.fileStream?.end();
    this.currentDay = day;
    this.fileStream = createWriteStream(dailyLogPath(this.basePath, now), {
      flags: 'a',
      encoding: 'utf8',
    });
  }

  private cleanupOldLogs(now: Date): void {
    const day = formatDay(now);
    if (this.lastCleanupDay === day) {
      return;
    }
    this.lastCleanupDay = day;
    pruneOldLogs(this.basePath, now, this.retentionDays);
  }

  override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    try {
      const now = new Date();
      this.ensureStream(now);
      this.cleanupOldLogs(now);
      this.fileStream?.write(chunk, encoding, callback);
    } catch (err) {
      callback(err instanceof Error ? err : new Error(String(err)));
    }
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.fileStream?.end(callback);
  }
}

export function createDailyLogStream(basePath: string, retentionDays = LOG_RETENTION_DAYS): DailyLogStream {
  return new DailyLogStream(basePath, retentionDays);
}
