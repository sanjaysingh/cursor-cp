/**
 * Tests for Telegram Markdown Formatting
 */

import { describe, it, expect } from 'vitest';
import { markdownToTelegram, splitForTelegram, markdownToTelegramHtml } from './telegram-format.js';

describe('markdownToTelegram', () => {
  it('should handle empty text', () => {
    const result = markdownToTelegram('');
    expect(result.text).toBe('');
    expect(result.entities).toEqual([]);
  });

  it('should process bold text', () => {
    const result = markdownToTelegram('This is **bold** text');
    expect(result.text).toBe('This is bold text');
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]).toMatchObject({
      type: 'bold',
      offset: 8,
      length: 4,
    });
  });

  it('should process italic text', () => {
    const result = markdownToTelegram('This is *italic* text');
    expect(result.text).toBe('This is italic text');
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]).toMatchObject({
      type: 'italic',
      offset: 8,
      length: 6,
    });
  });

  it('should process inline code', () => {
    const result = markdownToTelegram('Use `console.log()` for debugging');
    expect(result.text).toBe('Use console.log() for debugging');
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]).toMatchObject({
      type: 'code',
      offset: 4,
      length: 13,
    });
  });

  it('should process code blocks', () => {
    const input = '```typescript\nconst x = 1;\n```';
    const result = markdownToTelegram(input);
    expect(result.text).toBe('const x = 1;');
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]).toMatchObject({
      type: 'pre',
      language: 'typescript',
      offset: 0,
    });
  });

  it('should process links', () => {
    const result = markdownToTelegram('Visit [Cursor](https://cursor.com) for more');
    expect(result.text).toBe('Visit Cursor for more');
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]).toMatchObject({
      type: 'text_link',
      offset: 6,
      length: 6,
      url: 'https://cursor.com',
    });
  });

  it('should process strikethrough', () => {
    const result = markdownToTelegram('This is ~~deleted~~ text');
    expect(result.text).toBe('This is deleted text');
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]).toMatchObject({
      type: 'strikethrough',
      offset: 8,
      length: 7,
    });
  });

  it('should handle mixed formatting', () => {
    const result = markdownToTelegram('**Bold** and *italic* and `code`');
    expect(result.text).toBe('Bold and italic and code');
    expect(result.entities).toHaveLength(3);
    expect(result.entities[0].type).toBe('bold');
    expect(result.entities[1].type).toBe('italic');
    expect(result.entities[2].type).toBe('code');
  });

  it('should preserve paragraph breaks', () => {
    const input = 'First paragraph.\n\nSecond paragraph.';
    const result = markdownToTelegram(input);
    expect(result.text).toBe(input);
    expect(result.entities).toEqual([]);
  });

  it('should preserve newlines with formatting entities', () => {
    const input = '**Bold** intro.\n\nMore text here.';
    const result = markdownToTelegram(input);
    expect(result.text).toBe('Bold intro.\n\nMore text here.');
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].type).toBe('bold');
  });

  it('should preserve heading paragraph separation', () => {
    const input = '# Title\n\nBody text.';
    const result = markdownToTelegram(input);
    expect(result.text).toBe('Title\n\nBody text.');
    expect(result.entities[0]?.type).toBe('bold');
  });

  it('should not create overlapping bold for heading with strong', () => {
    const result = markdownToTelegram('## **Section**');
    expect(result.text).toBe('Section');
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]).toMatchObject({ type: 'bold', offset: 0, length: 7 });
  });

  it('should bold only strong text in mixed heading', () => {
    const result = markdownToTelegram('# **Title** here');
    expect(result.text).toBe('Title here');
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]).toMatchObject({ type: 'bold', offset: 0, length: 5 });
  });

  it('should handle text over 4096 chars', () => {
    const longText = 'a'.repeat(5000);
    const result = markdownToTelegram(longText);
    expect(result.text.length).toBeLessThanOrEqual(4096);
  });
});

describe('splitForTelegram', () => {
  it('should not split short text', () => {
    const result = splitForTelegram('Short text');
    expect(result).toHaveLength(1);
  });

  it('should split long text at paragraph breaks', () => {
    const paragraphs = Array(100).fill('Paragraph with some content here.\n\n');
    const longText = paragraphs.join('');
    const result = splitForTelegram(longText, 500);

    expect(result.length).toBeGreaterThan(1);
    // Each chunk should be under max length
    for (const chunk of result) {
      expect(chunk.text.length).toBeLessThanOrEqual(500);
    }
  });
});

describe('markdownToTelegramHtml', () => {
  it('should render bold as HTML', () => {
    const html = markdownToTelegramHtml('This is **bold** text');
    expect(html).toContain('<b>bold</b>');
  });

  it('should render headings as bold', () => {
    const html = markdownToTelegramHtml('## Section\n\nBody');
    expect(html).toContain('<b>Section</b>');
  });

  it('should render list items with bullets', () => {
    const html = markdownToTelegramHtml('- **Item 1**: detail');
    expect(html).toContain('<b>Item 1</b>');
    expect(html).toContain('•');
  });
});
