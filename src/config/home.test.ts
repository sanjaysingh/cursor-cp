/**
 * Tests for config path helpers
 */

import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { resolve } from 'path';
import {
  getProjectRoot,
  configDefaultPath,
  projectConfigPath,
  userConfigPath,
} from './home.js';

describe('config paths', () => {
  it('resolves project root relative to module location', () => {
    expect(existsSync(resolve(getProjectRoot(), 'package.json'))).toBe(true);
  });

  it('resolves config.default.yaml in the project root', () => {
    expect(configDefaultPath()).toBe(resolve(getProjectRoot(), 'config.default.yaml'));
    expect(existsSync(configDefaultPath())).toBe(true);
  });

  it('resolves user and project override paths', () => {
    expect(projectConfigPath()).toBe(resolve(getProjectRoot(), 'config.yaml'));
    expect(userConfigPath()).toMatch(/cursor-cp[/\\]config\.yaml$/);
  });
});
