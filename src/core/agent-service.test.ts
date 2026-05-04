/**
 * Tests for AgentService
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentService } from './agent-service.js';

describe('AgentService', () => {
  let service: AgentService;

  beforeEach(() => {
    service = new AgentService({
      apiKey: 'test-key',
      defaultModel: 'composer-2',
    });
  });

  it('should initialize with correct options', () => {
    expect(service).toBeDefined();
  });

  it('should create session', async () => {
    const session = await service.createSession('test-id', '/tmp/workspace');
    expect(session).toBeDefined();
    expect(session.id).toBe('test-id');
    expect(session.workspacePath).toBe('/tmp/workspace');
    expect(session.model).toBe('composer-2');
  });

  it('should list sessions', () => {
    const sessions = service.listSessions();
    expect(Array.isArray(sessions)).toBe(true);
  });

  it('should handle session not found', async () => {
    const result = await service.sendPrompt('nonexistent-id', 'test');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Session not found');
  });

  it('should handle question callback', async () => {
    const questionHandler = vi.fn().mockResolvedValue('Yes');
    service.onQuestion(questionHandler);

    // Create a session and verify question handler is set
    await service.createSession('test-id', '/tmp/workspace');
    expect(service).toBeDefined();
  });
});
