import { describe, it, expect, vi } from 'vitest';
import { isWedgedActiveRunError, isAuthRequiredError, formatRunFailure, errorMessage } from './agent-errors.js';

vi.mock('@cursor/sdk', () => ({
  AgentBusyError: class AgentBusyError extends Error {},
  CursorAgentError: class CursorAgentError extends Error {},
  CursorSdkError: class CursorSdkError extends Error {},
}));

describe('agent-errors', () => {
  it('detects wedged active run messages', () => {
    expect(isWedgedActiveRunError(new Error('Agent already has active run'))).toBe(true);
    expect(isWedgedActiveRunError(new Error('agent_busy'))).toBe(true);
    expect(isWedgedActiveRunError(new Error('network timeout'))).toBe(false);
  });

  it('formats unknown errors', () => {
    expect(errorMessage('oops')).toBe('oops');
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('detects stale login errors', () => {
    expect(
      isAuthRequiredError(
        'Authentication error If you are logged in, try logging out and back in.'
      )
    ).toBe(true);
    expect(isAuthRequiredError(new Error('auth token expired'))).toBe(true);
    expect(isAuthRequiredError('network timeout')).toBe(false);
  });

  it('formats run failures with the SDK reason', () => {
    expect(
      formatRunFailure(
        'run-1',
        'Authentication error If you are logged in, try logging out and back in.'
      )
    ).toBe('Authentication error. If you are logged in, try logging out and back in.');
    expect(formatRunFailure('run-1', 'Model blocked')).toBe('Model blocked');
    expect(formatRunFailure('run-1', '  ')).toBe('Agent run failed: run-1');
  });
});
