import { describe, expect, test } from 'bun:test';
import type { Note } from '../note/note.entity';
import {
  cosine,
  effectiveSummaryVector,
  topKSimilarTo,
  topKSimilarToSummary,
} from '../vector/vector.utils';

function makeNote(id: string, contentVector: number[], summaryVector: number[] = []): Note {
  return {
    id,
    title: id,
    content: 'content',
    status: 'processed',
    themeIds: [],
    createdAt: new Date(),
    summary: '',
    topics: [],
    contentVector,
    summaryVector,
    relatedNoteIds: [],
  };
}

describe('cosine', () => {
  test('identical vectors → 1', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
  });
  test('orthogonal vectors → 0', () => {
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
  });
  test('empty vector → 0', () => {
    expect(cosine([], [1, 0])).toBe(0);
  });
});

describe('topKSimilarTo', () => {
  test('returns IDs above threshold sorted by score', () => {
    const target = makeNote('t', [1, 0, 0]);
    const c1 = makeNote('c1', [0.999, 0.001, 0]);
    const c2 = makeNote('c2', [0, 1, 0]);
    const result = topKSimilarTo(target, [c1, c2], 0.75, 5);
    expect(result).toEqual(['c1']);
  });

  test('respects k limit', () => {
    const target = makeNote('t', [1, 0]);
    const corpus = [
      makeNote('a', [0.99, 0.01]),
      makeNote('b', [0.98, 0.02]),
      makeNote('c', [0.97, 0.03]),
    ];
    const result = topKSimilarTo(target, corpus, 0.5, 2);
    expect(result).toHaveLength(2);
  });

  test('excludes self', () => {
    const t = makeNote('t', [1, 0]);
    const result = topKSimilarTo(t, [t], 0.5, 5);
    expect(result).not.toContain('t');
  });

  test('returns empty when contentVector is empty', () => {
    const target = makeNote('t', []);
    const corpus = [makeNote('c', [1, 0])];
    expect(topKSimilarTo(target, corpus, 0.5, 5)).toEqual([]);
  });

  test('returns empty for empty corpus', () => {
    const target = makeNote('t', [1, 0]);
    expect(topKSimilarTo(target, [], 0.5, 5)).toEqual([]);
  });

  test('ties are ordered consistently', () => {
    const target = makeNote('t', [1, 0]);
    const c1 = makeNote('c1', [1, 0]);
    const c2 = makeNote('c2', [1, 0]);
    const result = topKSimilarTo(target, [c2, c1], 0.5, 5);
    expect(result).toHaveLength(2);
  });
});

describe('topKSimilarToSummary / effectiveSummaryVector', () => {
  test('uses summaryVector when present', () => {
    const target = makeNote('t', [0, 0, 1], [1, 0, 0]);
    const a = makeNote('a', [0, 0, 1], [0.999, 0.001, 0]);
    const b = makeNote('b', [1, 0, 0], [0, 0, 1]);
    const r = topKSimilarToSummary(target, [a, b], 0.75, 5);
    expect(r).toEqual(['a']);
  });

  test('falls back to contentVector when summaryVector is empty', () => {
    const target = makeNote('t', [1, 0, 0], []);
    const a = makeNote('a', [0.999, 0.001, 0], []);
    const r = topKSimilarToSummary(target, [a], 0.75, 5);
    expect(r).toEqual(['a']);
  });
});
