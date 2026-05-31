/**
 * Markdown → Telegram plain text + MessageEntity (UTF-16 offsets).
 * Adapted from telegramify-markdown / Python control_plane approach.
 */

import { marked } from 'marked';
import type { Token, Tokens } from 'marked';

export interface RawTelegramEntity {
  _: string;
  offset: number;
  length: number;
  url?: string;
  language?: string;
}

export interface RawParseResult {
  text: string;
  entities: RawTelegramEntity[];
}

export function getUtf16Length(str: string): number {
  return str.length;
}

const BLOCK_TOKEN_TYPES = new Set([
  'paragraph',
  'heading',
  'code',
  'blockquote',
  'list',
  'hr',
  'table',
]);

const INLINE_FORMAT_TYPES = new Set(['strong', 'em', 'codespan', 'del', 'link', 'image']);

function hasInlineFormatting(tokens: Token[] | undefined): boolean {
  if (!tokens) return false;
  for (const token of tokens) {
    if (INLINE_FORMAT_TYPES.has(token.type)) return true;
    if ('tokens' in token && Array.isArray(token.tokens)) {
      if (hasInlineFormatting(token.tokens as Token[])) return true;
    }
  }
  return false;
}

function dedupeEntities(entities: RawTelegramEntity[]): RawTelegramEntity[] {
  const seen = new Set<string>();
  const out: RawTelegramEntity[] = [];
  for (const entity of entities) {
    const key = `${entity._}:${entity.offset}:${entity.length}:${entity.url ?? ''}:${entity.language ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entity);
  }
  return out;
}

export function markdownToTelegramEntities(markdownText: string): RawParseResult {
  const tokens = marked.lexer(markdownText, { gfm: true });
  let plainText = '';
  const entities: RawTelegramEntity[] = [];

  function processTokens(tokenList: Token[] | undefined): void {
    if (!tokenList) return;

    for (let i = 0; i < tokenList.length; i++) {
      const token = tokenList[i];
      const startOffset = getUtf16Length(plainText);
      let entityType: string | null = null;
      const entityProps: { url?: string; language?: string } = {};

      switch (token.type) {
        case 'paragraph':
          processTokens(token.tokens);
          break;
        case 'strong':
          entityType = 'messageEntityBold';
          processTokens(token.tokens);
          break;
        case 'em':
          entityType = 'messageEntityItalic';
          processTokens(token.tokens);
          break;
        case 'del':
          entityType = 'messageEntityStrike';
          processTokens(token.tokens);
          break;
        case 'codespan':
          entityType = 'messageEntityCode';
          plainText += token.text;
          break;
        case 'code': {
          entityType = 'messageEntityPre';
          const codeToken = token as Tokens.Code;
          entityProps.language = codeToken.lang?.trim() || '';
          const codeText = codeToken.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
          plainText += codeText;
          break;
        }
        case 'link': {
          entityType = 'messageEntityTextUrl';
          const linkToken = token as Tokens.Link;
          entityProps.url = linkToken.href;
          processTokens(linkToken.tokens);
          break;
        }
        case 'blockquote': {
          entityType = 'messageEntityBlockquote';
          const bqToken = token as Tokens.Blockquote;
          if (bqToken.tokens) {
            bqToken.tokens.forEach((childToken, index) => {
              const textBeforeChild = plainText;
              processTokens([childToken]);
              if (
                plainText.length > textBeforeChild.length &&
                index < bqToken.tokens!.length - 1
              ) {
                const nextToken = bqToken.tokens![index + 1];
                if (
                  nextToken &&
                  BLOCK_TOKEN_TYPES.has(nextToken.type)
                ) {
                  plainText += '\n';
                }
              }
            });
          }
          break;
        }
        case 'list': {
          const listToken = token as Tokens.List;
          listToken.items.forEach((item, index) => {
            const textBeforeItem = plainText;
            processTokens(item.tokens);
            if (plainText.length > textBeforeItem.length && index < listToken.items.length - 1) {
              plainText += '\n';
            }
          });
          break;
        }
        case 'heading':
          // Avoid overlapping bold when heading already contains **strong** text
          if (!hasInlineFormatting(token.tokens)) {
            entityType = 'messageEntityBold';
          }
          processTokens(token.tokens);
          break;
        case 'hr':
          plainText += '---';
          break;
        case 'br':
          plainText += '\n';
          break;
        case 'space':
          // Blank lines between block elements — must preserve newlines
          plainText += token.raw || '\n\n';
          break;
        case 'text':
          if (token.tokens) {
            processTokens(token.tokens);
          } else {
            plainText += token.text;
          }
          break;
        case 'html':
          break;
        default:
          if ('tokens' in token && Array.isArray(token.tokens)) {
            processTokens(token.tokens as Token[]);
          } else if ('text' in token && typeof token.text === 'string') {
            plainText += token.text;
          } else if ('raw' in token && typeof token.raw === 'string' && BLOCK_TOKEN_TYPES.has(token.type)) {
            plainText += token.raw;
          }
          break;
      }

      if (entityType) {
        const currentTextLength = getUtf16Length(plainText) - startOffset;
        if (currentTextLength > 0) {
          entities.push({
            _: entityType,
            offset: startOffset,
            length: currentTextLength,
            ...entityProps,
          });
        }
      }
    }
  }

  processTokens(tokens as Token[]);
  return { text: plainText, entities: dedupeEntities(entities) };
}
