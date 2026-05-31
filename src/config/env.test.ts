/**
 * Tests for environment file loading
 */

import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { getEnvFilePath, getProjectRoot } from './env.js';

describe('env', () => {
  it('should resolve project root relative to module location', () => {
    expect(existsSync(resolve(getProjectRoot(), 'package.json'))).toBe(true);
  });

  it('should resolve env file path in project root', () => {
    expect(getEnvFilePath()).toBe(resolve(getProjectRoot(), '.env'));
  });
});
