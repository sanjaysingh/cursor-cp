/**
 * Tests for setup wizard
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { checkNeedsSetup } from './setup-wizard.js';
import { mkdtempSync, rmdirSync, unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';

describe('setup-wizard', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(resolve(tmpdir(), 'setup-test-'));
  });

  afterEach(() => {
    // Cleanup - ignore errors if files don't exist
    try {
      const envPath = resolve(tempDir, '.env');
      if (existsSync(envPath)) unlinkSync(envPath);
    } catch { /* ignore */ }
    try {
      rmdirSync(tempDir);
    } catch { /* ignore */ }
  });

  describe('checkNeedsSetup', () => {
    it('should return true when .env does not exist', () => {
      expect(checkNeedsSetup(tempDir)).toBe(true);
    });

    it('should return false when .env exists with valid API key', () => {
      const envPath = resolve(tempDir, '.env');
      const fs = require('fs');
      fs.writeFileSync(envPath, 'CURSOR_API_KEY=cursor_test_key_123\n');

      expect(checkNeedsSetup(tempDir)).toBe(false);
    });

    it('should return true when .env exists but API key is placeholder', () => {
      const envPath = resolve(tempDir, '.env');
      const fs = require('fs');
      fs.writeFileSync(envPath, 'CURSOR_API_KEY=your_cursor_api_key_here\n');

      expect(checkNeedsSetup(tempDir)).toBe(true);
    });
  });
});
