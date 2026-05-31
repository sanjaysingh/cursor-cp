/**
 * Markdown → Telegram HTML (parse_mode: HTML).
 * Uses Telegram-supported tags only: b, i, u, s, code, pre, a, tg-spoiler.
 */

import { marked } from 'marked';
import type { Tokens } from 'marked';

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, '&quot;');
}

let configured = false;

function ensureTelegramRenderer(): void {
  if (configured) return;
  configured = true;

  marked.use({
    gfm: true,
    renderer: {
      heading({ tokens }: Tokens.Heading) {
        const inner = this.parser.parseInline(tokens);
        return `<b>${inner}</b>\n\n`;
      },
      strong({ tokens }: Tokens.Strong) {
        return `<b>${this.parser.parseInline(tokens)}</b>`;
      },
      em({ tokens }: Tokens.Em) {
        return `<i>${this.parser.parseInline(tokens)}</i>`;
      },
      codespan({ text }: Tokens.Codespan) {
        return `<code>${escapeHtml(text)}</code>`;
      },
      code({ text }: Tokens.Code) {
        const body = escapeHtml(text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
        return `<pre>${body}</pre>\n\n`;
      },
      del({ tokens }: Tokens.Del) {
        return `<s>${this.parser.parseInline(tokens)}</s>`;
      },
      link({ href, tokens }: Tokens.Link) {
        return `<a href="${escapeAttr(href)}">${this.parser.parseInline(tokens)}</a>`;
      },
      blockquote({ tokens }: Tokens.Blockquote) {
        const inner = this.parser.parse(tokens).trim();
        return `<i>${inner}</i>\n\n`;
      },
      list(token: Tokens.List) {
        let body = '';
        for (const item of token.items) {
          body += this.listitem(item);
        }
        return `${body}\n`;
      },
      listitem(item: Tokens.ListItem) {
        return `• ${this.parser.parseInline(item.tokens)}\n`;
      },
      paragraph({ tokens }: Tokens.Paragraph) {
        return `${this.parser.parseInline(tokens)}\n\n`;
      },
      hr() {
        return '---\n\n';
      },
      html() {
        return '';
      },
      image() {
        return '';
      },
      table() {
        return '';
      },
    },
  });
}

/** Convert Markdown to Telegram-safe HTML (max 4096 chars). */
export function markdownToTelegramHtml(text: string): string {
  if (!text) return '';
  ensureTelegramRenderer();
  try {
    const html = marked.parse(text, { async: false }) as string;
    return html.trimEnd().slice(0, 4096);
  } catch {
    return escapeHtml(text).slice(0, 4096);
  }
}
