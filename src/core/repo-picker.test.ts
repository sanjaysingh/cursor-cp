/**
 * Tests for RepoPicker
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RepoPicker, type RepoPickerOptions } from './repo-picker.js';
import { mkdtempSync, mkdirSync, rmdirSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';

describe('RepoPicker', () => {
  let tempDir: string;
  let options: RepoPickerOptions;

  beforeEach(() => {
    tempDir = mkdtempSync(resolve(tmpdir(), 'repo-picker-test-'));
    options = {
      workspaceRoot: tempDir,
      repos: [],
      ghLimit: 10,
    };
  });

  afterEach(() => {
    // Cleanup
    try {
      const entries = require('fs').readdirSync(tempDir);
      for (const entry of entries) {
        const path = resolve(tempDir, entry);
        try {
          const stat = require('fs').statSync(path);
          if (stat.isDirectory()) {
            rmdirSync(path, { recursive: true });
          } else {
            unlinkSync(path);
          }
          } catch { /* ignore */ }
      }
      rmdirSync(tempDir);
    } catch { /* ignore */ }
  });

  it('should scan workspace directories', async () => {
    // Create test directories
    mkdirSync(resolve(tempDir, 'project-a'), { recursive: true });
    mkdirSync(resolve(tempDir, 'project-b'), { recursive: true });

    const picker = new RepoPicker(options);
    const result = await picker.buildItems();

    const localItems = result.items.filter((i) => i.type === 'local');
    expect(localItems.length).toBeGreaterThanOrEqual(2);
  });

  it('should deduplicate by path', async () => {
    // Add a repo that will also be in workspace
    const sharedPath = resolve(tempDir, 'shared-project');
    mkdirSync(sharedPath, { recursive: true });

    options.repos = [
      { name: 'shared-project', path: sharedPath, description: 'Configured' },
    ];

    const picker = new RepoPicker(options);
    const result = await picker.buildItems();

    const matching = result.items.filter((i) => i.path === sharedPath);
    expect(matching.length).toBe(1);
  });

  it('should handle empty workspace', async () => {
    const picker = new RepoPicker(options);
    const result = await picker.buildItems();

    expect(Array.isArray(result.items)).toBe(true);
  });

  it('should skip hidden directories', async () => {
    mkdirSync(resolve(tempDir, '.hidden'), { recursive: true });
    mkdirSync(resolve(tempDir, 'visible'), { recursive: true });

    const picker = new RepoPicker(options);
    const result = await picker.buildItems();

    const hiddenItem = result.items.find((i) => i.label.includes('hidden'));
    expect(hiddenItem).toBeUndefined();
  });
});
