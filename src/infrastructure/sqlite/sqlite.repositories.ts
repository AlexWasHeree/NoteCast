import type { Database } from 'bun:sqlite';
import type { INoteRepository, Note } from '../../domain/note/note.entity';
import type { IThemeRepository, Theme } from '../../domain/theme/theme.entity';
import type { IVectorStore, NoteVectors } from '../../domain/vector/vector.store';
import { logger } from '../logger';

const log = logger.child('Repo');

const EMPTY_NOTE_VECTORS: NoteVectors = { contentVector: [], summaryVector: [] };

export class SQLiteNoteRepository implements INoteRepository {
  constructor(
    private db: Database,
    private vectorStore: IVectorStore,
  ) {}

  private rowToNote(
    row: any,
    themeIds: string[],
    relatedNoteIds: string[],
    vectors: NoteVectors,
  ): Note {
    return {
      id: row.id,
      title: row.title,
      content: row.content,
      status: row.status,
      themeIds,
      createdAt: new Date(row.created_at),
      summary: row.summary,
      topics: JSON.parse(row.topics),
      contentVector: vectors.contentVector,
      summaryVector: vectors.summaryVector,
      relatedNoteIds,
      sourceFile: row.source_file ?? undefined,
      failureReason: row.failure_reason ?? undefined,
    };
  }

  async save(note: Note): Promise<void> {
    this.db.transaction(() => {
      this.db.run(
        `INSERT OR REPLACE INTO notes (id, title, content, status, created_at, summary, topics, source_file, failure_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          note.id,
          note.title,
          note.content,
          note.status,
          note.createdAt.toISOString(),
          note.summary,
          JSON.stringify(note.topics),
          note.sourceFile ?? null,
          note.failureReason ?? null,
        ],
      );
      this.db.run('DELETE FROM note_themes WHERE note_id = ?', [note.id]);
      for (const themeId of note.themeIds ?? []) {
        this.db.run('INSERT OR IGNORE INTO note_themes (note_id, theme_id) VALUES (?, ?)', [
          note.id,
          themeId,
        ]);
      }
      this.db.run('DELETE FROM note_relations WHERE note_id = ?', [note.id]);
      for (const relatedId of note.relatedNoteIds ?? []) {
        this.db.run('INSERT OR IGNORE INTO note_relations (note_id, related_id) VALUES (?, ?)', [
          note.id,
          relatedId,
        ]);
      }
    })();

    if (note.contentVector.length > 0 || note.summaryVector.length > 0) {
      await this.vectorStore.upsertNoteVectors(note.id, {
        contentVector: note.contentVector,
        summaryVector: note.summaryVector,
      });
    }
  }

  async findById(id: string): Promise<Note | null> {
    const row = this.db.query('SELECT * FROM notes WHERE id = ?').get(id);
    if (!row) return null;
    const themeIds = (
      this.db.query('SELECT theme_id FROM note_themes WHERE note_id = ?').all(id) as any[]
    ).map((r) => r.theme_id);
    const relatedNoteIds = (
      this.db.query('SELECT related_id FROM note_relations WHERE note_id = ?').all(id) as any[]
    ).map((r) => r.related_id);
    const vectorMap = await this.vectorStore.findNoteVectorsByIds([id]);
    return this.rowToNote(row, themeIds, relatedNoteIds, vectorMap.get(id) ?? EMPTY_NOTE_VECTORS);
  }

  async findAll(): Promise<Note[]> {
    const rows = this.db.query('SELECT * FROM notes').all();
    if (rows.length === 0) return [];
    const allNoteThemes = this.db.query('SELECT note_id, theme_id FROM note_themes').all() as any[];
    const allRelations = this.db
      .query('SELECT note_id, related_id FROM note_relations')
      .all() as any[];
    const themesByNote = new Map<string, string[]>();
    for (const r of allNoteThemes) {
      const arr = themesByNote.get(r.note_id) ?? [];
      arr.push(r.theme_id);
      themesByNote.set(r.note_id, arr);
    }
    const relatedByNote = new Map<string, string[]>();
    for (const r of allRelations) {
      const arr = relatedByNote.get(r.note_id) ?? [];
      arr.push(r.related_id);
      relatedByNote.set(r.note_id, arr);
    }
    const vectorMap = await this.vectorStore.findAllNoteVectors();
    return (rows as any[]).map((r) =>
      this.rowToNote(
        r,
        themesByNote.get(r.id) ?? [],
        relatedByNote.get(r.id) ?? [],
        vectorMap.get(r.id) ?? EMPTY_NOTE_VECTORS,
      ),
    );
  }

  async findByIds(ids: string[]): Promise<Note[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .query(`SELECT * FROM notes WHERE id IN (${placeholders})`)
      .all(...ids) as any[];
    if (rows.length === 0) return [];
    const allNoteThemes = this.db
      .query(`SELECT note_id, theme_id FROM note_themes WHERE note_id IN (${placeholders})`)
      .all(...ids) as any[];
    const allRelations = this.db
      .query(`SELECT note_id, related_id FROM note_relations WHERE note_id IN (${placeholders})`)
      .all(...ids) as any[];
    const themesByNote = new Map<string, string[]>();
    for (const r of allNoteThemes) {
      const arr = themesByNote.get(r.note_id) ?? [];
      arr.push(r.theme_id);
      themesByNote.set(r.note_id, arr);
    }
    const relatedByNote = new Map<string, string[]>();
    for (const r of allRelations) {
      const arr = relatedByNote.get(r.note_id) ?? [];
      arr.push(r.related_id);
      relatedByNote.set(r.note_id, arr);
    }
    const vectorMap = await this.vectorStore.findNoteVectorsByIds(ids);
    return rows.map((r) =>
      this.rowToNote(
        r,
        themesByNote.get(r.id) ?? [],
        relatedByNote.get(r.id) ?? [],
        vectorMap.get(r.id) ?? EMPTY_NOTE_VECTORS,
      ),
    );
  }

  async findByStatus(status: Note['status']): Promise<Note[]> {
    const rows = this.db.query('SELECT * FROM notes WHERE status = ?').all(status) as any[];
    if (rows.length === 0) return [];
    const noteIds = rows.map((r) => r.id);
    const placeholders = noteIds.map(() => '?').join(',');
    const allNoteThemes = this.db
      .query(`SELECT note_id, theme_id FROM note_themes WHERE note_id IN (${placeholders})`)
      .all(...noteIds) as any[];
    const allRelations = this.db
      .query(`SELECT note_id, related_id FROM note_relations WHERE note_id IN (${placeholders})`)
      .all(...noteIds) as any[];
    const themesByNote = new Map<string, string[]>();
    for (const r of allNoteThemes) {
      const arr = themesByNote.get(r.note_id) ?? [];
      arr.push(r.theme_id);
      themesByNote.set(r.note_id, arr);
    }
    const relatedByNote = new Map<string, string[]>();
    for (const r of allRelations) {
      const arr = relatedByNote.get(r.note_id) ?? [];
      arr.push(r.related_id);
      relatedByNote.set(r.note_id, arr);
    }
    const vectorMap = await this.vectorStore.findNoteVectorsByIds(noteIds);
    return rows.map((r) =>
      this.rowToNote(
        r,
        themesByNote.get(r.id) ?? [],
        relatedByNote.get(r.id) ?? [],
        vectorMap.get(r.id) ?? EMPTY_NOTE_VECTORS,
      ),
    );
  }

  async countAllStatuses(): Promise<Record<Note['status'], number>> {
    const rows = this.db
      .query(`SELECT status, COUNT(*) as count FROM notes GROUP BY status`)
      .all() as { status: string; count: number }[];
    const counts = { pending: 0, processed: 0, scanned: 0, organized: 0, failed: 0 } as Record<
      Note['status'],
      number
    >;
    for (const r of rows) counts[r.status as Note['status']] = r.count;
    return counts;
  }

  async resetAll(full: boolean): Promise<{ count: number; noteIds: string[] }> {
    let count = 0;
    const noteIds: string[] = [];
    this.db.transaction(() => {
      if (full) {
        const rows = this.db.query('SELECT id FROM notes').all() as { id: string }[];
        for (const r of rows) noteIds.push(r.id);
        count = rows.length;
        this.db.run('DELETE FROM notes');
      } else {
        const result = this.db.run(
          `UPDATE notes SET status='processed' WHERE status IN ('scanned','organized')`,
        );
        count = result.changes;
      }
      this.db.run('DELETE FROM note_themes');
      this.db.run('DELETE FROM note_relations');
    })();
    if (full) {
      await this.vectorStore.resetNoteVectors();
    }
    return { count, noteIds };
  }

  async update(note: Note): Promise<void> {
    return this.save(note);
  }

  async delete(id: string): Promise<void> {
    this.db.transaction(() => {
      this.db.run('DELETE FROM note_themes WHERE note_id = ?', [id]);
      this.db.run('DELETE FROM note_relations WHERE note_id = ?', [id]);
      this.db.run('DELETE FROM notes WHERE id = ?', [id]);
    })();
    await this.vectorStore.deleteNoteVectors(id);
  }

  async knnByContentVector(vector: number[], k: number, threshold: number): Promise<string[]> {
    return this.vectorStore.knnByContentVector(vector, k, threshold);
  }

  async knnBySummaryVector(vector: number[], k: number, threshold: number): Promise<string[]> {
    return this.vectorStore.knnBySummaryVector(vector, k, threshold);
  }
}

export class SQLiteThemeRepository implements IThemeRepository {
  constructor(
    private db: Database,
    private vectorStore: IVectorStore,
  ) {}

  private rowToTheme(
    row: any,
    noteIds: string[],
    parentIds: string[],
    descriptionVector?: number[],
  ): Theme {
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      ...(descriptionVector !== undefined ? { descriptionVector } : {}),
      parentIds,
      noteIds,
      createdAt: new Date(row.created_at),
    };
  }

  async save(theme: Theme): Promise<void> {
    this.db.transaction(() => {
      this.db.run(
        `INSERT OR REPLACE INTO themes (id, name, description, created_at) VALUES (?, ?, ?, ?)`,
        [theme.id, theme.name, theme.description ?? null, theme.createdAt.toISOString()],
      );
      this.db.run('DELETE FROM theme_parents WHERE child_id = ?', [theme.id]);
      for (const parentId of theme.parentIds) {
        this.db.run('INSERT OR IGNORE INTO theme_parents (child_id, parent_id) VALUES (?, ?)', [
          theme.id,
          parentId,
        ]);
      }
      this.db.run('DELETE FROM note_themes WHERE theme_id = ?', [theme.id]);
      for (const noteId of theme.noteIds) {
        this.db.run('INSERT OR IGNORE INTO note_themes (note_id, theme_id) VALUES (?, ?)', [
          noteId,
          theme.id,
        ]);
      }
    })();

    if (theme.descriptionVector && theme.descriptionVector.length > 0) {
      await this.vectorStore.upsertThemeVector(theme.id, theme.descriptionVector);
    }
  }

  async findById(id: string): Promise<Theme | null> {
    const row = this.db.query('SELECT * FROM themes WHERE id = ?').get(id);
    if (!row) return null;
    const noteIds = (
      this.db.query('SELECT note_id FROM note_themes WHERE theme_id = ?').all(id) as any[]
    ).map((r) => r.note_id);
    const parentIds = (
      this.db.query('SELECT parent_id FROM theme_parents WHERE child_id = ?').all(id) as any[]
    ).map((r) => r.parent_id);
    const vectorMap = await this.vectorStore.findThemeVectorsByIds([id]);
    return this.rowToTheme(row, noteIds, parentIds, vectorMap.get(id));
  }

  async findByName(name: string): Promise<Theme | null> {
    const row = this.db.query('SELECT * FROM themes WHERE name = ?').get(name);
    if (!row) return null;
    const id = (row as any).id;
    const noteIds = (
      this.db.query('SELECT note_id FROM note_themes WHERE theme_id = ?').all(id) as any[]
    ).map((r) => r.note_id);
    const parentIds = (
      this.db.query('SELECT parent_id FROM theme_parents WHERE child_id = ?').all(id) as any[]
    ).map((r) => r.parent_id);
    const vectorMap = await this.vectorStore.findThemeVectorsByIds([id]);
    return this.rowToTheme(row, noteIds, parentIds, vectorMap.get(id));
  }

  async findAll(): Promise<Theme[]> {
    const rows = this.db.query('SELECT * FROM themes').all();
    if (rows.length === 0) return [];
    const allNoteThemes = this.db.query('SELECT note_id, theme_id FROM note_themes').all() as any[];
    const allParents = this.db
      .query('SELECT child_id, parent_id FROM theme_parents')
      .all() as any[];
    const notesByTheme = new Map<string, string[]>();
    for (const r of allNoteThemes) {
      const arr = notesByTheme.get(r.theme_id) ?? [];
      arr.push(r.note_id);
      notesByTheme.set(r.theme_id, arr);
    }
    const parentsByTheme = new Map<string, string[]>();
    for (const r of allParents) {
      const arr = parentsByTheme.get(r.child_id) ?? [];
      arr.push(r.parent_id);
      parentsByTheme.set(r.child_id, arr);
    }
    const themeIds = (rows as any[]).map((r) => r.id);
    const vectorMap = await this.vectorStore.findThemeVectorsByIds(themeIds);
    return (rows as any[]).map((r) =>
      this.rowToTheme(
        r,
        notesByTheme.get(r.id) ?? [],
        parentsByTheme.get(r.id) ?? [],
        vectorMap.get(r.id),
      ),
    );
  }

  async deleteAll(): Promise<number> {
    let count = 0;
    this.db.transaction(() => {
      this.db.run('DELETE FROM theme_parents');
      this.db.run('DELETE FROM note_themes');
      const result = this.db.run('DELETE FROM themes');
      count = result.changes;
    })();
    await this.vectorStore.resetThemeVectors();
    return count;
  }

  async update(theme: Theme): Promise<void> {
    return this.save(theme);
  }

  async delete(id: string): Promise<void> {
    const childCount = this.db
      .query('SELECT COUNT(*) as n FROM theme_parents WHERE parent_id = ?')
      .get(id) as { n: number };
    if (childCount.n > 0) {
      throw new Error(
        `Cannot delete theme ${id}: it has ${childCount.n} child(ren). Re-parent them first.`,
      );
    }
    this.db.transaction(() => {
      this.db.run('DELETE FROM note_themes WHERE theme_id = ?', [id]);
      this.db.run('DELETE FROM theme_parents WHERE child_id = ?', [id]);
      this.db.run('DELETE FROM themes WHERE id = ?', [id]);
    })();
    await this.vectorStore.deleteThemeVector(id);
  }

  async knnByThemeVector(vector: number[], k: number, threshold: number): Promise<string[]> {
    return this.vectorStore.knnByThemeVector(vector, k, threshold);
  }
}
