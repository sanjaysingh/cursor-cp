/**
 * Telegraf resilience helpers — keep polling alive when handlers fail.
 */

import type { Context } from 'telegraf';
import type { Update } from 'telegraf/types';

/** Default Telegraf handlerTimeout is 90s; agent runs often exceed that. */
export const TELEGRAM_HANDLER_TIMEOUT_MS = 3_600_000;

export function formatTelegramError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}

export async function replySafe(ctx: Context<Update>, text: string): Promise<void> {
  try {
    await ctx.reply(text);
  } catch (replyErr) {
    console.error('Failed to send Telegram reply:', replyErr);
  }
}

/**
 * Wrap a Telegraf handler so errors are logged and the user gets feedback
 * instead of becoming an unhandled rejection that can break polling.
 */
export function wrapTelegramHandler(
  name: string,
  handler: (ctx: Context<Update>) => Promise<void>
): (ctx: Context<Update>) => Promise<void> {
  return async (ctx) => {
    try {
      await handler(ctx);
    } catch (err) {
      console.error(`Telegram handler "${name}" failed:`, err);
      await replySafe(ctx, `❌ Error: ${formatTelegramError(err)}`);
    }
  };
}
