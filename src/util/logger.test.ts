import { describe, it, expect } from 'vitest';
import { resolve } from 'path';
import { homedir } from 'os';
import { logger, formatLocalTimestamp, getLogFilePath } from './logger.js';

describe('logger', () => {
  it('exports a pino logger', () => {
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
  });

  it('formats local timestamps with offset', () => {
    const formatted = formatLocalTimestamp(new Date('2026-05-30T21:14:45.322Z'));
    expect(formatted).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} [+-]\d{2}:\d{2}$/);
  });

  it('enables file logging by default under logs/', () => {
    expect(getLogFilePath()).toBe(resolve(homedir(), 'cursor-cp', 'logs', 'cursor-cp.log'));
  });
});
