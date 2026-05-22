import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LanceDBVectorStore } from './lancedb.vector.store';

const DIM = 4;

function vec(values: number[]): number[] {
  // pad/trim to DIM for test convenience
  return values.slice(0, DIM).concat(Array(Math.max(0, DIM - values.length)).fill(0));
}

let dir: string;
let store: LanceDBVectorStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lancedb-test-'));
  store = await LanceDBVectorStore.open(dir, DIM);
});

afterEach(() => {
  rmSync(dir, { recursive: true });
});

describe('note vectors', () => {
  test('upsert + findAllNoteVectors', async () => {
    await store.upsertNoteVectors('n1', {
      contentVector: vec([1, 0, 0, 0]),
      summaryVector: vec([0, 1, 0, 0]),
    });
    const map = await store.findAllNoteVectors();
    expect(map.size).toBe(1);
    expect(map.get('n1')?.contentVector).toHaveLength(DIM);
    expect(map.get('n1')?.summaryVector).toHaveLength(DIM);
  });

  test('upsert is idempotent (update on re-insert)', async () => {
    await store.upsertNoteVectors('n1', {
      contentVector: vec([1, 0, 0, 0]),
      summaryVector: vec([0, 1, 0, 0]),
    });
    await store.upsertNoteVectors('n1', {
      contentVector: vec([0, 0, 1, 0]),
      summaryVector: vec([0, 0, 0, 1]),
    });
    const map = await store.findAllNoteVectors();
    expect(map.size).toBe(1);
    expect(Array.from(map.get('n1')!.contentVector)).toEqual(vec([0, 0, 1, 0]));
  });

  test('findNoteVectorsByIds returns only matching IDs', async () => {
    await store.upsertNoteVectors('n1', {
      contentVector: vec([1, 0, 0, 0]),
      summaryVector: vec([1, 0, 0, 0]),
    });
    await store.upsertNoteVectors('n2', {
      contentVector: vec([0, 1, 0, 0]),
      summaryVector: vec([0, 1, 0, 0]),
    });
    const map = await store.findNoteVectorsByIds(['n1']);
    expect(map.size).toBe(1);
    expect(map.has('n1')).toBe(true);
    expect(map.has('n2')).toBe(false);
  });

  test('deleteNoteVectors removes the entry', async () => {
    await store.upsertNoteVectors('n1', {
      contentVector: vec([1, 0, 0, 0]),
      summaryVector: vec([1, 0, 0, 0]),
    });
    await store.deleteNoteVectors('n1');
    const map = await store.findAllNoteVectors();
    expect(map.size).toBe(0);
  });

  test('resetNoteVectors clears all entries', async () => {
    await store.upsertNoteVectors('n1', {
      contentVector: vec([1, 0, 0, 0]),
      summaryVector: vec([1, 0, 0, 0]),
    });
    await store.upsertNoteVectors('n2', {
      contentVector: vec([0, 1, 0, 0]),
      summaryVector: vec([0, 1, 0, 0]),
    });
    await store.resetNoteVectors();
    const map = await store.findAllNoteVectors();
    expect(map.size).toBe(0);
  });

  test('knnByContentVector returns IDs above threshold', async () => {
    await store.upsertNoteVectors('close', {
      contentVector: vec([0.999, 0.001, 0, 0]),
      summaryVector: vec([0, 0, 0, 1]),
    });
    await store.upsertNoteVectors('far', {
      contentVector: vec([0, 0, 0, 1]),
      summaryVector: vec([1, 0, 0, 0]),
    });
    const results = await store.knnByContentVector(vec([1, 0, 0, 0]), 5, 0.8);
    expect(results).toContain('close');
    expect(results).not.toContain('far');
  });

  test('knnBySummaryVector uses the summary column', async () => {
    // contentVector is far, summaryVector is close
    await store.upsertNoteVectors('n1', {
      contentVector: vec([0, 0, 0, 1]),
      summaryVector: vec([0.999, 0.001, 0, 0]),
    });
    const byContent = await store.knnByContentVector(vec([1, 0, 0, 0]), 5, 0.8);
    const bySummary = await store.knnBySummaryVector(vec([1, 0, 0, 0]), 5, 0.8);
    expect(byContent).not.toContain('n1');
    expect(bySummary).toContain('n1');
  });
});

describe('theme vectors', () => {
  test('upsert + findAllThemeVectors', async () => {
    await store.upsertThemeVector('t1', vec([1, 0, 0, 0]));
    const map = await store.findAllThemeVectors();
    expect(map.size).toBe(1);
    expect(map.get('t1')).toHaveLength(DIM);
  });

  test('deleteThemeVector removes entry', async () => {
    await store.upsertThemeVector('t1', vec([1, 0, 0, 0]));
    await store.deleteThemeVector('t1');
    const map = await store.findAllThemeVectors();
    expect(map.size).toBe(0);
  });

  test('resetThemeVectors clears all entries', async () => {
    await store.upsertThemeVector('t1', vec([1, 0, 0, 0]));
    await store.upsertThemeVector('t2', vec([0, 1, 0, 0]));
    await store.resetThemeVectors();
    const map = await store.findAllThemeVectors();
    expect(map.size).toBe(0);
  });

  test('knnByThemeVector returns IDs above threshold', async () => {
    await store.upsertThemeVector('close', vec([0.999, 0.001, 0, 0]));
    await store.upsertThemeVector('far', vec([0, 0, 0, 1]));
    const results = await store.knnByThemeVector(vec([1, 0, 0, 0]), 5, 0.8);
    expect(results).toContain('close');
    expect(results).not.toContain('far');
  });
});

describe('empty store edge cases', () => {
  test('findAllNoteVectors returns empty map when store is empty', async () => {
    const map = await store.findAllNoteVectors();
    expect(map.size).toBe(0);
  });

  test('findNoteVectorsByIds returns empty map for empty ids array', async () => {
    const map = await store.findNoteVectorsByIds([]);
    expect(map.size).toBe(0);
  });

  test('knnByContentVector returns empty for empty vector', async () => {
    const results = await store.knnByContentVector([], 5, 0.8);
    expect(results).toEqual([]);
  });

  test('knnByContentVector returns empty when store is empty', async () => {
    const results = await store.knnByContentVector(vec([1, 0, 0, 0]), 5, 0.8);
    expect(results).toEqual([]);
  });

  test('resetNoteVectors is safe on empty store', async () => {
    await expect(store.resetNoteVectors()).resolves.toBeUndefined();
  });
});
