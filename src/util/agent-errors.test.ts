import { describe, it, expect } from 'vitest';
import { isWedgedActiveRunError, errorMessage } from './agent-errors.js';

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
});
