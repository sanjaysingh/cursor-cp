/**
 * Shared application logger (pino).
 * Set LOG_LEVEL=debug for verbose SDK/agent output.
 *
 * JSON output uses string levels ("info", "error", …) and local timestamps.
 * Logs go to stdout and, by default, daily files under the user data directory.
 */

import pino, { type Logger, type LoggerOptions } from 'pino';
import type { FastifyLoggerOptions } from 'fastify';
import { resolveLogFilePath } from '../paths.js';
import { createDailyLogStream } from './daily-log-stream.js';

/** Local wall-clock time with UTC offset, e.g. `2026-05-30 17:14:45.322 -04:00`. */
export function formatLocalTimestamp(date = new Date()): string {
  const pad = (value: number, length = 2) => String(value).padStart(length, '0');

  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  const millis = pad(date.getMilliseconds(), 3);

  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const offsetHours = pad(Math.floor(Math.abs(offsetMinutes) / 60));
  const offsetMins = pad(Math.abs(offsetMinutes) % 60);

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${millis} ${sign}${offsetHours}:${offsetMins}`;
}

export function createLoggerOptions(): LoggerOptions {
  return {
    level: process.env.LOG_LEVEL ?? 'info',
    formatters: {
      level(label) {
        return { level: label };
      },
    },
    timestamp() {
      return `,"time":"${formatLocalTimestamp()}"`;
    },
  };
}

function createLogStreams(): pino.StreamEntry[] {
  const streams: pino.StreamEntry[] = [{ stream: process.stdout }];
  const logFileBase = resolveLogFilePath();
  if (logFileBase) {
    streams.push({ stream: createDailyLogStream(logFileBase) });
  }
  return streams;
}

export function buildLogger(): Logger {
  const options = createLoggerOptions();
  const streams = createLogStreams();
  if (streams.length === 1) {
    return pino(options);
  }
  return pino(options, pino.multistream(streams));
}

/** Fastify-compatible logger config (stdout + optional daily log file). */
export function createFastifyLoggerConfig(): FastifyLoggerOptions {
  const options = createLoggerOptions();
  const streams = createLogStreams();
  if (streams.length === 1) {
    return options;
  }
  return {
    ...options,
    stream: pino.multistream(streams),
  };
}

let loggerInstance: Logger | undefined;

export function getLogger(): Logger {
  if (!loggerInstance) {
    loggerInstance = buildLogger();
  }
  return loggerInstance;
}

/** Resolved base log path, or null when file logging is disabled. */
export function getLogFilePath(): string | null {
  return resolveLogFilePath();
}

export const logger = getLogger();

export type { Logger };
