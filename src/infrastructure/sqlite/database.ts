import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '../logger';

const log = logger.child('DB');

export function createDatabase(path: string = './notes.db'): Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.run('PRAGMA journal_mode=WAL');
  db.run('PRAGMA foreign_keys=ON');

  db.run(`
    CREATE TABLE IF NOT EXISTS notes (
      id         TEXT PRIMARY KEY,
      title      TEXT NOT NULL,
      content    TEXT NOT NULL,
      status     TEXT NOT NULL,
      created_at TEXT NOT NULL,
      summary    TEXT NOT NULL DEFAULT '',
      topics     TEXT NOT NULL DEFAULT '[]'
    )
  `);

  // Migration: add source_file and failure_reason columns if not present
  db.transaction(() => {
    const noteCols = db.query('PRAGMA table_info(notes)').all() as { name: string }[];
    if (!noteCols.find((c) => c.name === 'source_file')) {
      db.run('ALTER TABLE notes ADD COLUMN source_file TEXT');
    }
    if (!noteCols.find((c) => c.name === 'failure_reason')) {
      db.run('ALTER TABLE notes ADD COLUMN failure_reason TEXT');
    }
  })();

  db.run(`
    CREATE TABLE IF NOT EXISTS themes (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT,
      created_at  TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS note_themes (
      note_id  TEXT NOT NULL,
      theme_id TEXT NOT NULL,
      PRIMARY KEY (note_id, theme_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS theme_parents (
      child_id  TEXT NOT NULL,
      parent_id TEXT NOT NULL,
      PRIMARY KEY (child_id, parent_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS note_relations (
      note_id    TEXT NOT NULL,
      related_id TEXT NOT NULL,
      PRIMARY KEY (note_id, related_id)
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_note_themes_theme_id ON note_themes(theme_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_theme_parents_parent_id ON theme_parents(parent_id)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS scan_proposals (
      type       TEXT PRIMARY KEY,
      proposal   TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS scan_state (
      id                                   INTEGER PRIMARY KEY DEFAULT 1,
      organized_count_at_last_consolidate  INTEGER NOT NULL DEFAULT 0,
      classify_commit_count                INTEGER NOT NULL DEFAULT 0,
      organize_commit_count                INTEGER NOT NULL DEFAULT 0,
      updated_at                           TEXT NOT NULL
    )
  `);

  db.run(`
    INSERT OR IGNORE INTO scan_state (id, organized_count_at_last_consolidate, updated_at)
    VALUES (1, 0, datetime('now'))
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS user_config (
      id                      INTEGER PRIMARY KEY DEFAULT 1,
      theme_style             TEXT NOT NULL DEFAULT 'short-phrase',
      theme_style_instruction TEXT,
      base_themes             TEXT NOT NULL DEFAULT '[]',
      pipeline_config         TEXT NOT NULL DEFAULT '{"classifyEvery":10,"organizeAfterClassifies":2,"consolidateAfterOrganizes":3}',
      updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    INSERT OR IGNORE INTO user_config (id, theme_style, base_themes, updated_at)
    VALUES (1, 'short-phrase', '[]', datetime('now'))
  `);

  // Migration: add vault_path and context_md columns if not present
  db.transaction(() => {
    const configCols = db.query('PRAGMA table_info(user_config)').all() as { name: string }[];
    if (!configCols.find((c) => c.name === 'vault_path')) {
      db.run('ALTER TABLE user_config ADD COLUMN vault_path TEXT');
    }
    if (!configCols.find((c) => c.name === 'context')) {
      db.run('ALTER TABLE user_config ADD COLUMN context TEXT');
    }
    if (!configCols.find((c) => c.name === 'note_language')) {
      db.run("ALTER TABLE user_config ADD COLUMN note_language TEXT NOT NULL DEFAULT 'english'");
    }
    if (!configCols.find((c) => c.name === 'summary_provider')) {
      db.run("ALTER TABLE user_config ADD COLUMN summary_provider TEXT NOT NULL DEFAULT 'ollama'");
    }
    if (!configCols.find((c) => c.name === 'summary_model')) {
      db.run('ALTER TABLE user_config ADD COLUMN summary_model TEXT');
    }
    if (!configCols.find((c) => c.name === 'llm_config')) {
      db.run('ALTER TABLE user_config ADD COLUMN llm_config TEXT');
    }
    const currentCols = db.query('PRAGMA table_info(user_config)').all() as { name: string }[];
    if (!currentCols.find((c) => c.name === 'language')) {
      if (currentCols.find((c) => c.name === 'note_language')) {
        db.run('ALTER TABLE user_config RENAME COLUMN note_language TO language');
      } else {
        db.run("ALTER TABLE user_config ADD COLUMN language TEXT NOT NULL DEFAULT 'english'");
      }
    }
    if (!currentCols.find((c) => c.name === 'default_provider')) {
      db.run('ALTER TABLE user_config ADD COLUMN default_provider TEXT');
    }
    if (!currentCols.find((c) => c.name === 'vault_links')) {
      db.run('ALTER TABLE user_config ADD COLUMN vault_links INTEGER');
    }
  })();

  log.info('Database opened', { path });
  return db;
}
