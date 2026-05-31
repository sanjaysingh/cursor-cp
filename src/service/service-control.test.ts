/**
 * Tests for ServiceController
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ServiceController } from './service-control.js';

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
}));

describe('ServiceController', () => {
  let controller: ServiceController;

  beforeEach(() => {
    controller = new ServiceController();
  });

  it('should detect if service is not installed', () => {
    expect(controller.isInstalled()).toBe(false);
  });

  it('should return unknown status when not installed', () => {
    expect(controller.getStatus()).toBe('unknown');
  });

  it('should have install method', () => {
    expect(typeof controller.install).toBe('function');
  });

  it('should have start method', () => {
    expect(typeof controller.start).toBe('function');
  });

  it('should have stop method', () => {
    expect(typeof controller.stop).toBe('function');
  });

  it('should have restart method', () => {
    expect(typeof controller.restart).toBe('function');
  });

  it('should have uninstall method', () => {
    expect(typeof controller.uninstall).toBe('function');
  });
});
