/**
 * Convert Markdown to Telegram Bot API text + MessageEntity (no parse_mode).
 * Mirrors Python control_plane/telegram_format.py.
 */

import { markdownToTelegramEntities } from './markdown-to-telegram-entities.js';
import { markdownToTelegramHtml } from './markdown-to-telegram-html.js';
import { logger } from '../util/logger.js';

export { markdownToTelegramHtml };

export type MessageEntityType =
  | 'bold'
  | 'italic'
  | 'code'
  | 'pre'
  | 'text_link'
  | 'text_mention'
  | 'underline'
  | 'strikethrough'
  | 'spoiler'
  | 'blockquote';

export interface MessageEntity {
  type: MessageEntityType;
  offset: number;
  length: number;
  url?: string;
  language?: string;
}

export interface FormattedText {
  text: string;
  entities: MessageEntity[];
}

const ENTITY_TYPE_MAP: Record<string, MessageEntityType> = {
  messageEntityBold: 'bold',
  messageEntityItalic: 'italic',
  messageEntityCode: 'code',
  messageEntityPre: 'pre',
  messageEntityTextUrl: 'text_link',
  messageEntityStrike: 'strikethrough',
  messageEntityStrikethrough: 'strikethrough',
  messageEntityBlockquote: 'blockquote',
  messageEntityUnderline: 'underline',
  messageEntitySpoiler: 'spoiler',
};

/**
 * Convert Markdown to plain text + entities for Telegram (UTF-16 offsets).
 * Returns plain text with no entities on failure or when text exceeds 4096 chars.
 */
export function markdownToTelegram(text: string): FormattedText {
  if (!text) {
    return { text: '', entities: [] };
  }

  try {
    const { text: plain, entities: rawEntities } = markdownToTelegramEntities(text);

    if (plain.length > 4096) {
      return { text: text.slice(0, 4096), entities: [] };
    }

    if (!rawEntities.length) {
      // No inline/block formatting — keep original spacing and newlines
      return { text: text.slice(0, 4096), entities: [] };
    }

    const entities: MessageEntity[] = [];
    for (const entity of rawEntities) {
      const type = ENTITY_TYPE_MAP[entity._];
      if (!type) {
        logger.debug({ entityType: entity._ }, 'Unknown Telegram entity type, skipping');
        continue;
      }

      entities.push({
        type,
        offset: entity.offset,
        length: entity.length,
        ...(entity.url ? { url: entity.url } : {}),
        ...(entity.language ? { language: entity.language } : {}),
      });
    }

    return { text: plain, entities };
  } catch (err) {
    logger.debug({ err }, 'markdownToTelegramEntities failed');
    return { text: text.slice(0, 4096), entities: [] };
  }
}

/** Send plain text in 4096-char chunks (no parse_mode). */
export function splitPlainText(text: string, maxLength = 4096): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    let splitPoint = maxLength;

    const paragraphBreak = remaining.lastIndexOf('\n\n', maxLength);
    if (paragraphBreak > maxLength * 0.5) {
      splitPoint = paragraphBreak + 2;
    } else {
      const sentenceEnd = remaining.lastIndexOf('. ', maxLength);
      if (sentenceEnd > maxLength * 0.5) {
        splitPoint = sentenceEnd + 2;
      }
    }

    const chunk = remaining.slice(0, splitPoint).trimEnd();
    if (chunk) {
      chunks.push(chunk);
    }
    remaining = remaining.slice(splitPoint).trimStart();
  }

  return chunks;
}

/**
 * Split long messages for Telegram.
 * Short messages get markdown entities; long messages are sent as plain chunks.
 */
export function splitForTelegram(
  text: string,
  maxLength = 4096
): Array<{ text: string; entities?: MessageEntity[] }> {
  if (text.length <= maxLength) {
    const formatted = markdownToTelegram(text);
    if (formatted.entities.length > 0) {
      return [{ text: formatted.text, entities: formatted.entities }];
    }
    return [{ text: formatted.text }];
  }

  return splitPlainText(text, maxLength).map((chunk) => ({ text: chunk }));
}

/** Map internal entities to Telegraf/Telegram Bot API shape. */
export function toTelegramApiEntities(entities: MessageEntity[]) {
  return entities.map((e) => ({
    type: e.type,
    offset: e.offset,
    length: e.length,
    ...(e.url ? { url: e.url } : {}),
    ...(e.language ? { language: e.language } : {}),
  }));
}
