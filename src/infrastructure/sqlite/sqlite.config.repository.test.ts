import type { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { createDatabase } from './database';
import { SQLiteUserConfigRepository } from './sqlite.config.repository';

describe('SQLiteUserConfigRepository.vaultPath', () => {
  let db: Database;
  let repo: SQLiteUserConfigRepository;

  beforeEach(() => {
    db = createDatabase(':memory:');
    repo = new SQLiteUserConfigRepository(db);
  });

  test('saves and loads vaultPath', async () => {
    const config = await repo.get();
    config.vaultPath = '/Users/alex/vault';
    await repo.save(config);

    const loaded = await repo.get();
    expect(loaded.vaultPath).toBe('/Users/alex/vault');
  });

  test('vaultPath is undefined when not set', async () => {
    const config = await repo.get();
    expect(config.vaultPath).toBeUndefined();
  });
});
