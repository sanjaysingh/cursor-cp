/**
 * Telegram Markdown Formatting
 * Converts Markdown to Telegram's MessageEntity format for rich text
 */

export type MessageEntityType =
  | 'bold'
  | 'italic'
  | 'code'
  | 'pre'
  | 'text_link'
  | 'text_mention'
  | 'underline'
  | 'strikethrough'
  | 'spoiler';

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

/**
 * Parse markdown and extract Telegram entities
 * Returns plain text with entity positions for Telegram API
 */
export function markdownToTelegram(text: string): FormattedText {
  if (!text) {
    return { text: '', entities: [] };
  }

  // Telegram has a 4096 character limit for messages with entities
  if (text.length > 4096) {
    return { text: text.slice(0, 4096), entities: [] };
  }

  const entities: MessageEntity[] = [];
  let plainText = text;
  let offsetShift = 0;

  // Process patterns in order of priority
  // 1. Code blocks (```) - must be before inline code
  plainText = processCodeBlocks(plainText, entities, offsetShift);

  // Recalculate offset after code blocks
  offsetShift = text.length - plainText.length;

  // 2. Inline code (`)
  plainText = processInlineCode(plainText, entities);

  // 3. Bold (** or __)
  plainText = processBold(plainText, entities);

  // 4. Italic (* or _)
  plainText = processItalic(plainText, entities);

  // 5. Strikethrough (~~)
  plainText = processStrikethrough(plainText, entities);

  // 6. Links [text](url)
  plainText = processLinks(plainText, entities);

  // Clean up any remaining markdown characters
  plainText = cleanupMarkdown(plainText);

  // Sort entities by offset for correct rendering order
  entities.sort((a, b) => a.offset - b.offset);

  return { text: plainText.slice(0, 4096), entities };
}

/**
 * Process code blocks ```code``` or ```lang\ncode```
 */
function processCodeBlocks(
  text: string,
  entities: MessageEntity[],
  baseOffset: number
): string {
  const codeBlockRegex = /```(\w+)?\n?([\s\S]*?)```/g;
  let result = text;
  let match;
  const replacements: Array<{
    start: number;
    end: number;
    replacement: string;
    entity: MessageEntity;
  }> = [];

  while ((match = codeBlockRegex.exec(text)) !== null) {
    const fullMatch = match[0];
    const language = match[1];
    const code = match[2].trimEnd();
    const start = match.index;

    replacements.push({
      start,
      end: start + fullMatch.length,
      replacement: code,
      entity: {
        type: 'pre',
        offset: start - baseOffset,
        length: code.length,
        language: language || undefined,
      },
    });
  }

  // Apply replacements in reverse order to maintain indices
  // Store temporarily and add in correct order
  const tempEntities: MessageEntity[] = [];
  for (let i = replacements.length - 1; i >= 0; i--) {
    const { start, end, replacement, entity } = replacements[i];
    result = result.slice(0, start) + replacement + result.slice(end);
    tempEntities.push(entity);
  }
  // Add in original order (reversed from processing)
  entities.push(...tempEntities.reverse());

  return result;
}

/**
 * Process inline code `code`
 */
function processInlineCode(text: string, entities: MessageEntity[]): string {
  const inlineCodeRegex = /`([^`]+)`/g;
  let result = text;
  let match;
  const replacements: Array<{
    start: number;
    end: number;
    replacement: string;
    entity: MessageEntity;
  }> = [];

  while ((match = inlineCodeRegex.exec(text)) !== null) {
    const fullMatch = match[0];
    const code = match[1];
    const start = match.index;

    // Skip if inside a code block (already processed)
    if (isInsideCodeBlock(text, start)) {
      continue;
    }

    replacements.push({
      start,
      end: start + fullMatch.length,
      replacement: code,
      entity: {
        type: 'code',
        offset: start,
        length: code.length,
      },
    });
  }

  // Apply in reverse order
  const tempEntities: MessageEntity[] = [];
  for (let i = replacements.length - 1; i >= 0; i--) {
    const { start, end, replacement, entity } = replacements[i];
    // Recalculate offset based on current result length
    entity.offset = start;
    result = result.slice(0, start) + replacement + result.slice(end);
    tempEntities.push(entity);
  }
  entities.push(...tempEntities.reverse());

  return result;
}

/**
 * Process bold **text** or __text__
 */
function processBold(text: string, entities: MessageEntity[]): string {
  const boldRegex = /(\*\*|__)(.+?)\1/g;
  return processPattern(text, entities, boldRegex, 'bold');
}

/**
 * Process italic *text* or _text_
 */
function processItalic(text: string, entities: MessageEntity[]): string {
  const italicRegex = /(\*|_)(.+?)\1/g;
  return processPattern(text, entities, italicRegex, 'italic');
}

/**
 * Process strikethrough ~~text~~
 */
function processStrikethrough(text: string, entities: MessageEntity[]): string {
  const strikeRegex = /~~(.+?)~~/g;
  let result = text;
  let match;
  const replacements: Array<{
    start: number;
    end: number;
    replacement: string;
    entity: MessageEntity;
  }> = [];

  while ((match = strikeRegex.exec(text)) !== null) {
    const fullMatch = match[0];
    const content = match[1];
    const start = match.index;

    replacements.push({
      start,
      end: start + fullMatch.length,
      replacement: content,
      entity: {
        type: 'strikethrough',
        offset: start,
        length: content.length,
      },
    });
  }

  // Apply in reverse order to maintain indices
  const tempEntities: MessageEntity[] = [];
  for (let i = replacements.length - 1; i >= 0; i--) {
    const { start, end, replacement, entity } = replacements[i];
    entity.offset = start;
    result = result.slice(0, start) + replacement + result.slice(end);
    tempEntities.push(entity);
  }
  entities.push(...tempEntities.reverse());

  return result;
}

/**
 * Process links [text](url)
 */
function processLinks(text: string, entities: MessageEntity[]): string {
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  let result = text;
  let match;
  const replacements: Array<{
    start: number;
    end: number;
    replacement: string;
    entity: MessageEntity;
  }> = [];

  while ((match = linkRegex.exec(text)) !== null) {
    const fullMatch = match[0];
    const linkText = match[1];
    const url = match[2];
    const start = match.index;

    replacements.push({
      start,
      end: start + fullMatch.length,
      replacement: linkText,
      entity: {
        type: 'text_link',
        offset: start,
        length: linkText.length,
        url,
      },
    });
  }

  // Apply in reverse order
  const tempEntities: MessageEntity[] = [];
  for (let i = replacements.length - 1; i >= 0; i--) {
    const { start, end, replacement, entity } = replacements[i];
    entity.offset = start;
    result = result.slice(0, start) + replacement + result.slice(end);
    tempEntities.push(entity);
  }
  entities.push(...tempEntities.reverse());

  return result;
}

/**
 * Generic pattern processor for simple markdown with delimiters
 * Pattern format: (delimiter)(content)\1
 */
function processPattern(
  text: string,
  entities: MessageEntity[],
  regex: RegExp,
  type: MessageEntityType
): string {
  let result = text;
  let match;
  const replacements: Array<{
    start: number;
    end: number;
    replacement: string;
    entity: MessageEntity;
  }> = [];

  while ((match = regex.exec(text)) !== null) {
    const fullMatch = match[0];
    // match[1] is delimiter, match[2] is content
    const content = match[2] || match[1]; // fallback for single capture group patterns
    const start = match.index;

    if (!content) continue;

    replacements.push({
      start,
      end: start + fullMatch.length,
      replacement: content,
      entity: {
        type,
        offset: start,
        length: content.length,
      },
    });
  }

  // Apply in reverse order
  const tempEntities: MessageEntity[] = [];
  for (let i = replacements.length - 1; i >= 0; i--) {
    const { start, end, replacement, entity } = replacements[i];
    entity.offset = start;
    result = result.slice(0, start) + replacement + result.slice(end);
    tempEntities.push(entity);
  }
  entities.push(...tempEntities.reverse());

  return result;
}

/**
 * Check if position is inside a code block
 */
function isInsideCodeBlock(text: string, position: number): boolean {
  const before = text.slice(0, position);
  const codeBlockMatches = before.match(/```/g);
  return codeBlockMatches ? codeBlockMatches.length % 2 === 1 : false;
}

/**
 * Clean up any remaining markdown characters that weren't processed
 */
function cleanupMarkdown(text: string): string {
  // Remove stray backslashes before markdown chars (except in code)
  return text.replace(/\\([*_`[~])/g, '$1');
}

/**
 * Split long messages for Telegram (max 4096 chars)
 * Returns array of chunks that can be sent separately
 */
export function splitForTelegram(
  text: string,
  maxLength = 4096
): Array<{ text: string; entities?: MessageEntity[] }> {
  if (text.length <= maxLength) {
    const formatted = markdownToTelegram(text);
    return [{ text: formatted.text, entities: formatted.entities }];
  }

  const chunks: Array<{ text: string; entities?: MessageEntity[] }> = [];
  let remaining = text;

  while (remaining.length > 0) {
    // Try to split at a paragraph or sentence boundary
    let splitPoint = maxLength;

    // Look for paragraph break
    const paragraphBreak = remaining.lastIndexOf('\n\n', maxLength);
    if (paragraphBreak > maxLength * 0.5) {
      splitPoint = paragraphBreak + 2;
    } else {
      // Look for sentence end
      const sentenceEnd = remaining.lastIndexOf('. ', maxLength);
      if (sentenceEnd > maxLength * 0.5) {
        splitPoint = sentenceEnd + 2;
      }
    }

    const chunk = remaining.slice(0, splitPoint).trim();
    if (chunk) {
      const formatted = markdownToTelegram(chunk);
      chunks.push({ text: formatted.text, entities: formatted.entities });
    }

    remaining = remaining.slice(splitPoint).trimStart();
  }

  return chunks;
}
