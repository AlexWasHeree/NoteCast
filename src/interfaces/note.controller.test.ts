import { describe, expect, test } from 'bun:test';
import type { Note } from '../domain/note/note.entity';
import { toPublicNote } from './note.controller';

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: 'n1',
    title: 'Test',
    content: 'Content',
    status: 'processed',
    themeIds: ['t1'],
    createdAt: new Date('2026-01-01'),
    summary: 'A summary',
    topics: ['topic1'],
    contentVector: Array.from({ length: 768 }, (_, i) => i * 0.001),
    summaryVector: Array.from({ length: 768 }, (_, i) => i * 0.002),
    relatedNoteIds: ['n2'],
    ...overrides,
  };
}

describe('toPublicNote', () => {
  test('strips vector and graphVector', () => {
    const note = makeNote();
    const pub = toPublicNote(note);
    expect((pub as any).contentVector).toBeUndefined();
    expect((pub as any).summaryVector).toBeUndefined();
  });

  test('preserves all other fields', () => {
    const note = makeNote();
    const pub = toPublicNote(note);
    expect(pub.id).toBe('n1');
    expect(pub.title).toBe('Test');
    expect(pub.content).toBe('Content');
    expect(pub.status).toBe('processed');
    expect(pub.themeIds).toEqual(['t1']);
    expect(pub.summary).toBe('A summary');
    expect(pub.topics).toEqual(['topic1']);
    expect(pub.relatedNoteIds).toEqual(['n2']);
  });
});
