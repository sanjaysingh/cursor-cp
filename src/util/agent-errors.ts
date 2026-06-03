/**
 * Helpers for recovering from Cursor SDK agent errors.
 */

import { AgentBusyError, CursorAgentError, CursorSdkError } from '@cursor/sdk';

export function isWedgedActiveRunError(err: unknown): boolean {
  const message = errorMessage(err).toLowerCase();
  return message.includes('already has active run') || message.includes('agent_busy');
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

export function formatAgentErrorForUser(err: unknown): string {
  if (err instanceof CursorAgentError || err instanceof CursorSdkError) {
    return err.message;
  }
  return errorMessage(err);
}

export { AgentBusyError };
