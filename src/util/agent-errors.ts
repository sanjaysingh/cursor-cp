/**
 * Helpers for recovering from Cursor SDK agent errors.
 */

import { AgentBusyError, CursorAgentError, CursorSdkError } from '@cursor/sdk';

export function isWedgedActiveRunError(err: unknown): boolean {
  const message = errorMessage(err).toLowerCase();
  return message.includes('already has active run') || message.includes('agent_busy');
}

/**
 * Cursor returns these when the long-lived local executor's login is stale
 * (ERROR_NOT_LOGGED_IN / expired auth token). Restarting the executor and
 * retrying once usually clears it.
 */
export function isAuthRequiredError(err: unknown): boolean {
  const message = errorMessage(err).toLowerCase();
  return (
    message.includes('authentication error') ||
    message.includes('not logged in') ||
    message.includes('try logging out') ||
    message.includes('auth token expired') ||
    message.includes('auth token not found')
  );
}

/**
 * User-facing text for a finished run whose status is `error`.
 * The SDK stores the reason on the run record and omits it from `RunResult`.
 */
export function formatRunFailure(runId: string, detail?: string | null): string {
  const raw = detail?.trim();
  if (!raw) {
    return `Agent run failed: ${runId}`;
  }

  const title = 'Authentication error';
  if (raw.startsWith(`${title} `)) {
    const rest = raw.slice(title.length).trim();
    return rest ? `${title}. ${rest}` : title;
  }

  return raw;
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
