import { beforeEach, describe, expect, test } from 'bun:test';
import { createDatabase } from './database';
import { SQLiteScanProposalStore } from './sqlite.scan.store';

let store: SQLiteScanProposalStore;

beforeEach(() => {
  const db = createDatabase(':memory:');
  store = new SQLiteScanProposalStore(db);
});

describe('incrementCommitCount', () => {
  test('increments classify_commit_count and returns new value', async () => {
    const first = await store.incrementCommitCount('classify');
    expect(first).toBe(1);
    const second = await store.incrementCommitCount('classify');
    expect(second).toBe(2);
  });

  test('increments organize_commit_count and returns new value', async () => {
    const first = await store.incrementCommitCount('organize');
    expect(first).toBe(1);
    const second = await store.incrementCommitCount('organize');
    expect(second).toBe(2);
  });

  test('classify and organize counters are independent', async () => {
    await store.incrementCommitCount('classify');
    await store.incrementCommitCount('classify');
    await store.incrementCommitCount('organize');

    const state = await store.getScanState();
    expect(state.classifyCommitCount).toBe(2);
    expect(state.organizeCommitCount).toBe(1);
  });
});
