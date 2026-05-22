import { describe, expect, test } from 'bun:test';
import {
  buildGraphEmbedText,
  buildMainEmbedText,
  GRAPH_EMBED_CONTENT_FALLBACK_MAX,
} from '../note/note.embedding-text';

describe('note.embedding-text', () => {
  test('buildMainEmbedText includes YAKE topics', () => {
    const s = buildMainEmbedText({
      title: 'Title',
      content: 'Note body.',
      topics: ['a', 'b'],
    });
    expect(s).toContain('Title');
    expect(s).toContain('Note body.');
    expect(s).toContain('Topics: a, b');
  });

  test('buildGraphEmbedText uses summary and topics when summary is present', () => {
    const s = buildGraphEmbedText({
      title: 'X',
      content: `LONG ${'z'.repeat(5000)}`,
      summary: 'Short summary.',
      topics: ['t1'],
    });
    expect(s).toContain('Short summary.');
    expect(s).toContain('Topics: t1');
    expect(s).not.toContain('zzzz');
  });

  test('buildGraphEmbedText falls back to truncated content when no summary', () => {
    const long = 'p'.repeat(GRAPH_EMBED_CONTENT_FALLBACK_MAX + 500);
    const s = buildGraphEmbedText({
      title: 'Y',
      content: long,
      summary: '   ',
      topics: [],
    });
    expect(s.length).toBeLessThan(long.length + 20);
    expect(s).toContain('p'.repeat(100));
  });
});
