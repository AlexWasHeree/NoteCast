import type { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import type { Note } from '../../domain/note/note.entity';
import type { Theme } from '../../domain/theme/theme.entity';
import type { IVectorStore, NoteVectors } from '../../domain/vector/vector.store';
import { createDatabase } from './database';
import { SQLiteNoteRepository, SQLiteThemeRepository } from './sqlite.repositories';

/** In-memory IVectorStore for fast repository tests — no file I/O. */
class InMemoryVectorStore implements IVectorStore {
  private noteVectors = new Map<string, NoteVectors>();
  private themeVectors = new Map<string, number[]>();

  async upsertNoteVectors(id: string, vectors: NoteVectors): Promise<void> {
    this.noteVectors.set(id, vectors);
  }
  async deleteNoteVectors(id: string): Promise<void> {
    this.noteVectors.delete(id);
  }
  async resetNoteVectors(): Promise<void> {
    this.noteVectors.clear();
  }
  async findNoteVectorsByIds(ids: string[]): Promise<Map<string, NoteVectors>> {
    const result = new Map<string, NoteVectors>();
    for (const id of ids) {
      const v = this.noteVectors.get(id);
      if (v) result.set(id, v);
    }
    return result;
  }
  async findAllNoteVectors(): Promise<Map<string, NoteVectors>> {
    return new Map(this.noteVectors);
  }
  async knnByContentVector(vector: number[], k: number, threshold: number): Promise<string[]> {
    return this._knn(vector, k, threshold, (v) => v.contentVector);
  }
  async knnBySummaryVector(vector: number[], k: number, threshold: number): Promise<string[]> {
    return this._knn(vector, k, threshold, (v) => v.summaryVector);
  }
  private _knn(
    query: number[],
    k: number,
    threshold: number,
    pick: (v: NoteVectors) => number[],
  ): string[] {
    const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i]!, 0);
    const mag = (a: number[]) => Math.sqrt(a.reduce((s, v) => s + v * v, 0));
    const cosine = (a: number[], b: number[]) => {
      const d = mag(a) * mag(b);
      return d === 0 ? 0 : dot(a, b) / d;
    };
    const results: { id: string; score: number }[] = [];
    for (const [id, vecs] of this.noteVectors) {
      const v = pick(vecs);
      if (v.length === 0) continue;
      const score = cosine(query, v);
      if (score >= threshold) results.push({ id, score });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, k).map((r) => r.id);
  }

  async upsertThemeVector(id: string, descriptionVector: number[]): Promise<void> {
    this.themeVectors.set(id, descriptionVector);
  }
  async deleteThemeVector(id: string): Promise<void> {
    this.themeVectors.delete(id);
  }
  async resetThemeVectors(): Promise<void> {
    this.themeVectors.clear();
  }
  async findThemeVectorsByIds(ids: string[]): Promise<Map<string, number[]>> {
    const result = new Map<string, number[]>();
    for (const id of ids) {
      const v = this.themeVectors.get(id);
      if (v) result.set(id, v);
    }
    return result;
  }
  async findAllThemeVectors(): Promise<Map<string, number[]>> {
    return new Map(this.themeVectors);
  }
  async knnByThemeVector(): Promise<string[]> {
    return [];
  }
}

function makeNote(id: string, overrides: Partial<Note> = {}): Note {
  return {
    id,
    title: `Note ${id}`,
    content: 'content',
    status: 'processed',
    themeIds: [],
    createdAt: new Date('2026-01-01'),
    summary: 'summary',
    topics: [],
    contentVector: [],
    summaryVector: [],
    relatedNoteIds: [],
    ...overrides,
  };
}

function makeTheme(id: string, overrides: Partial<Theme> = {}): Theme {
  return {
    id,
    name: `Theme ${id}`,
    noteIds: [],
    parentIds: [],
    createdAt: new Date('2026-01-01'),
    ...overrides,
  };
}

describe('createDatabase — PRAGMA settings', () => {
  test('foreign_keys is ON', () => {
    const db = createDatabase(':memory:');
    const row = db.query('PRAGMA foreign_keys').get() as { foreign_keys: number };
    expect(row.foreign_keys).toBe(1);
  });
});

describe('SQLiteNoteRepository', () => {
  let noteRepo: SQLiteNoteRepository;
  let vectorStore: InMemoryVectorStore;

  beforeEach(() => {
    const db = createDatabase(':memory:');
    vectorStore = new InMemoryVectorStore();
    noteRepo = new SQLiteNoteRepository(db, vectorStore);
  });

  test('save + findById roundtrip with empty relations', async () => {
    const note = makeNote('n1');
    await noteRepo.save(note);
    const found = await noteRepo.findById('n1');
    expect(found).not.toBeNull();
    expect(found?.id).toBe('n1');
    expect(found?.themeIds).toEqual([]);
    expect(found?.relatedNoteIds).toEqual([]);
  });

  test('save persists themeIds in join table', async () => {
    const db = (noteRepo as any).db;
    const note = makeNote('n1', { themeIds: ['t1', 't2'] });
    await noteRepo.save(note);
    const found = await noteRepo.findById('n1');
    expect(found?.themeIds).toEqual(expect.arrayContaining(['t1', 't2']));
    expect(found?.themeIds).toHaveLength(2);
    // Verify data is in the join table, not only in the JSON column
    const rows = db.query('SELECT theme_id FROM note_themes WHERE note_id = ?').all('n1') as {
      theme_id: string;
    }[];
    expect(rows.map((r) => r.theme_id)).toEqual(expect.arrayContaining(['t1', 't2']));
    expect(rows).toHaveLength(2);
  });

  test('save persists relatedNoteIds in join table', async () => {
    const db = (noteRepo as any).db;
    await noteRepo.save(makeNote('n1'));
    await noteRepo.save(makeNote('n2'));
    const note = makeNote('n3', { relatedNoteIds: ['n1', 'n2'] });
    await noteRepo.save(note);
    const found = await noteRepo.findById('n3');
    expect(found?.relatedNoteIds).toEqual(expect.arrayContaining(['n1', 'n2']));
    expect(found?.relatedNoteIds).toHaveLength(2);
    // Verify data is in the join table, not only in the JSON column
    const rows = db.query('SELECT related_id FROM note_relations WHERE note_id = ?').all('n3') as {
      related_id: string;
    }[];
    expect(rows.map((r) => r.related_id)).toEqual(expect.arrayContaining(['n1', 'n2']));
    expect(rows).toHaveLength(2);
  });

  test('update replaces themeIds', async () => {
    const db = (noteRepo as any).db;
    await noteRepo.save(makeNote('n1', { themeIds: ['t1', 't2'] }));
    await noteRepo.update(makeNote('n1', { themeIds: ['t3'] }));
    const found = await noteRepo.findById('n1');
    expect(found?.themeIds).toEqual(['t3']);
    // Verify old join table entries were removed
    const rows = db.query('SELECT theme_id FROM note_themes WHERE note_id = ?').all('n1') as {
      theme_id: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.theme_id).toBe('t3');
  });

  test('update replaces relatedNoteIds', async () => {
    const db = (noteRepo as any).db;
    await noteRepo.save(makeNote('n1', { relatedNoteIds: ['n2', 'n3'] }));
    await noteRepo.update(makeNote('n1', { relatedNoteIds: ['n4'] }));
    const found = await noteRepo.findById('n1');
    expect(found?.relatedNoteIds).toEqual(['n4']);
    // Verify old join table entries were removed
    const rows = db.query('SELECT related_id FROM note_relations WHERE note_id = ?').all('n1') as {
      related_id: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.related_id).toBe('n4');
  });

  test('findAll returns all notes with correct themeIds', async () => {
    await noteRepo.save(makeNote('n1', { themeIds: ['t1'] }));
    await noteRepo.save(makeNote('n2', { themeIds: ['t1', 't2'] }));
    await noteRepo.save(makeNote('n3', { themeIds: [] }));
    const all = await noteRepo.findAll();
    expect(all).toHaveLength(3);
    const n1 = all.find((n) => n.id === 'n1')!;
    const n2 = all.find((n) => n.id === 'n2')!;
    const n3 = all.find((n) => n.id === 'n3')!;
    expect(n1.themeIds).toEqual(['t1']);
    expect(n2.themeIds).toEqual(expect.arrayContaining(['t1', 't2']));
    expect(n3.themeIds).toEqual([]);
  });

  test('findByStatus returns filtered notes with correct themeIds', async () => {
    await noteRepo.save(makeNote('n1', { status: 'processed', themeIds: ['t1'] }));
    await noteRepo.save(makeNote('n2', { status: 'scanned', themeIds: ['t2'] }));
    const processed = await noteRepo.findByStatus('processed');
    expect(processed).toHaveLength(1);
    expect(processed[0]!.themeIds).toEqual(['t1']);
  });

  test('delete removes note and its join table entries', async () => {
    const db = (noteRepo as any).db;
    await noteRepo.save(makeNote('n1', { themeIds: ['t1'], relatedNoteIds: ['n2'] }));
    await noteRepo.delete('n1');
    const found = await noteRepo.findById('n1');
    expect(found).toBeNull();
    const all = await noteRepo.findAll();
    expect(all).toHaveLength(0);
    // Verify join table entries were cleaned up
    const themeRows = db.query('SELECT * FROM note_themes WHERE note_id = ?').all('n1');
    expect(themeRows).toHaveLength(0);
    const relRows = db.query('SELECT * FROM note_relations WHERE note_id = ?').all('n1');
    expect(relRows).toHaveLength(0);
  });

  test('findById returns null for unknown id', async () => {
    const found = await noteRepo.findById('nonexistent');
    expect(found).toBeNull();
  });

  test('save persists contentVector and summaryVector to the vector store', async () => {
    const note: Note = {
      id: 'n1',
      title: 'T',
      content: 'C',
      status: 'pending',
      themeIds: [],
      createdAt: new Date(),
      summary: '',
      topics: [],
      contentVector: [0.1, 0.2, 0.3],
      summaryVector: [0.4, 0.5, 0.6],
      relatedNoteIds: [],
    };
    await noteRepo.save(note);
    const map = await vectorStore.findAllNoteVectors();
    expect(map.get('n1')?.contentVector).toEqual([0.1, 0.2, 0.3]);
    expect(map.get('n1')?.summaryVector).toEqual([0.4, 0.5, 0.6]);
  });

  test('findAll hydrates contentVector and summaryVector from vector store', async () => {
    const vec = [0.1, 0.2, 0.3];
    const gvec = [0.4, 0.5, 0.6];
    const note: Note = {
      id: 'n1',
      title: 'T',
      content: 'C',
      status: 'pending',
      themeIds: [],
      createdAt: new Date(),
      summary: '',
      topics: [],
      contentVector: vec,
      summaryVector: gvec,
      relatedNoteIds: [],
    };
    await noteRepo.save(note);
    const notes = await noteRepo.findAll();
    const r1 = notes.find((n) => n.id === 'n1')!;
    expect(r1.contentVector).toEqual(vec);
    expect(r1.summaryVector).toEqual(gvec);
  });

  test('findByIds returns only the requested notes with vectors hydrated', async () => {
    const n1: Note = {
      id: 'n1',
      title: 'A',
      content: 'C',
      status: 'pending',
      themeIds: [],
      createdAt: new Date(),
      summary: '',
      topics: [],
      contentVector: [0.1],
      summaryVector: [0.2],
      relatedNoteIds: [],
    };
    const n2: Note = {
      id: 'n2',
      title: 'B',
      content: 'D',
      status: 'pending',
      themeIds: [],
      createdAt: new Date(),
      summary: '',
      topics: [],
      contentVector: [0.3],
      summaryVector: [0.4],
      relatedNoteIds: [],
    };
    await noteRepo.save(n1);
    await noteRepo.save(n2);

    const results = await noteRepo.findByIds(['n1']);
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe('n1');
    expect(results[0]!.contentVector).toEqual([0.1]);
  });
});

describe('SQLiteThemeRepository', () => {
  let themeRepo: SQLiteThemeRepository;
  let vectorStore: InMemoryVectorStore;

  beforeEach(() => {
    const db = createDatabase(':memory:');
    vectorStore = new InMemoryVectorStore();
    themeRepo = new SQLiteThemeRepository(db, vectorStore);
  });

  test('save + findById roundtrip with empty relations', async () => {
    await themeRepo.save(makeTheme('t1'));
    const found = await themeRepo.findById('t1');
    expect(found).not.toBeNull();
    expect(found?.id).toBe('t1');
    expect(found?.noteIds).toEqual([]);
    expect(found?.parentIds).toEqual([]);
  });

  test('save persists noteIds in join table', async () => {
    await themeRepo.save(makeTheme('t1', { noteIds: ['n1', 'n2'] }));
    const found = await themeRepo.findById('t1');
    expect(found?.noteIds).toEqual(expect.arrayContaining(['n1', 'n2']));
    expect(found?.noteIds).toHaveLength(2);
  });

  test('save persists parentIds in join table', async () => {
    await themeRepo.save(makeTheme('root'));
    await themeRepo.save(makeTheme('child', { parentIds: ['root'] }));
    const found = await themeRepo.findById('child');
    expect(found?.parentIds).toEqual(['root']);
  });

  test('save persists multiple parentIds (multi-parent DAG)', async () => {
    await themeRepo.save(makeTheme('p1'));
    await themeRepo.save(makeTheme('p2'));
    await themeRepo.save(makeTheme('child', { parentIds: ['p1', 'p2'] }));
    const found = await themeRepo.findById('child');
    expect(found?.parentIds).toEqual(expect.arrayContaining(['p1', 'p2']));
    expect(found?.parentIds).toHaveLength(2);
  });

  test('update replaces noteIds', async () => {
    await themeRepo.save(makeTheme('t1', { noteIds: ['n1', 'n2'] }));
    await themeRepo.update(makeTheme('t1', { noteIds: ['n3'] }));
    const found = await themeRepo.findById('t1');
    expect(found?.noteIds).toEqual(['n3']);
  });

  test('update replaces parentIds', async () => {
    await themeRepo.save(makeTheme('t1', { parentIds: ['p1'] }));
    await themeRepo.update(makeTheme('t1', { parentIds: ['p2'] }));
    const found = await themeRepo.findById('t1');
    expect(found?.parentIds).toEqual(['p2']);
  });

  test('findAll returns all themes with correct relations', async () => {
    await themeRepo.save(makeTheme('root'));
    await themeRepo.save(makeTheme('child', { parentIds: ['root'], noteIds: ['n1'] }));
    const all = await themeRepo.findAll();
    expect(all).toHaveLength(2);
    const child = all.find((t) => t.id === 'child')!;
    expect(child.parentIds).toEqual(['root']);
    expect(child.noteIds).toEqual(['n1']);
  });

  test('findByName returns correct theme', async () => {
    await themeRepo.save(makeTheme('t1', { name: 'Machine Learning' }));
    const found = await themeRepo.findByName('Machine Learning');
    expect(found).not.toBeNull();
    expect(found?.id).toBe('t1');
  });

  test('delete removes theme and its join table entries', async () => {
    const db = (themeRepo as any).db;
    await themeRepo.save(makeTheme('parent'));
    await themeRepo.save(makeTheme('child', { parentIds: ['parent'], noteIds: ['n1'] }));
    await themeRepo.delete('child');
    expect(await themeRepo.findById('child')).toBeNull();
    expect(await themeRepo.findById('parent')).not.toBeNull();
    const parentRows = db.query('SELECT * FROM theme_parents WHERE child_id = ?').all('child');
    expect(parentRows).toHaveLength(0);
    const noteRows = db.query('SELECT * FROM note_themes WHERE theme_id = ?').all('child');
    expect(noteRows).toHaveLength(0);
  });

  test('delete throws when theme has children to prevent silent DAG corruption', async () => {
    await themeRepo.save(makeTheme('parent'));
    await themeRepo.save(makeTheme('child', { parentIds: ['parent'] }));
    await expect(themeRepo.delete('parent')).rejects.toThrow(/child/i);
    expect(await themeRepo.findById('parent')).not.toBeNull();
  });

  test('delete succeeds after children are re-parented', async () => {
    await themeRepo.save(makeTheme('parent'));
    await themeRepo.save(makeTheme('child', { parentIds: ['parent'] }));
    await themeRepo.update(makeTheme('child', { parentIds: [] }));
    await expect(themeRepo.delete('parent')).resolves.toBeUndefined();
    expect(await themeRepo.findById('parent')).toBeNull();
  });
});

describe('SQLiteNoteRepository — countAllStatuses', () => {
  let noteRepo: SQLiteNoteRepository;

  beforeEach(() => {
    const db = createDatabase(':memory:');
    const vectorStore = new InMemoryVectorStore();
    noteRepo = new SQLiteNoteRepository(db, vectorStore);
  });

  test('returns zero counts when empty', async () => {
    const counts = await noteRepo.countAllStatuses();
    expect(counts.pending).toBe(0);
    expect(counts.processed).toBe(0);
    expect(counts.scanned).toBe(0);
    expect(counts.organized).toBe(0);
  });

  test('counts each status correctly', async () => {
    await noteRepo.save(makeNote('n1', { status: 'pending' }));
    await noteRepo.save(makeNote('n2', { status: 'pending' }));
    await noteRepo.save(makeNote('n3', { status: 'processed' }));
    await noteRepo.save(makeNote('n4', { status: 'scanned' }));
    await noteRepo.save(makeNote('n5', { status: 'organized' }));
    await noteRepo.save(makeNote('n6', { status: 'organized' }));

    const counts = await noteRepo.countAllStatuses();
    expect(counts.pending).toBe(2);
    expect(counts.processed).toBe(1);
    expect(counts.scanned).toBe(1);
    expect(counts.organized).toBe(2);
  });
});

describe('SQLiteThemeRepository — deleteAll', () => {
  let themeRepo: SQLiteThemeRepository;
  let db: any;

  beforeEach(() => {
    db = createDatabase(':memory:');
    const vectorStore = new InMemoryVectorStore();
    themeRepo = new SQLiteThemeRepository(db, vectorStore);
  });

  test('deletes all themes and returns count', async () => {
    await themeRepo.save(makeTheme('t1'));
    await themeRepo.save(makeTheme('t2'));
    const count = await themeRepo.deleteAll();
    expect(count).toBe(2);
    expect(await themeRepo.findAll()).toHaveLength(0);
  });

  test('clears theme_parents rows', async () => {
    await themeRepo.save(makeTheme('root'));
    await themeRepo.save(makeTheme('child', { parentIds: ['root'] }));
    await themeRepo.deleteAll();
    const rows = db.query('SELECT * FROM theme_parents').all();
    expect(rows).toHaveLength(0);
  });

  test('clears note_themes rows', async () => {
    await themeRepo.save(makeTheme('t1', { noteIds: ['n1', 'n2'] }));
    await themeRepo.deleteAll();
    const rows = db.query('SELECT * FROM note_themes').all();
    expect(rows).toHaveLength(0);
  });

  test('returns 0 when already empty', async () => {
    const count = await themeRepo.deleteAll();
    expect(count).toBe(0);
  });
});

describe('SQLiteNoteRepository — resetAll', () => {
  let noteRepo: SQLiteNoteRepository;
  let db: any;

  beforeEach(() => {
    db = createDatabase(':memory:');
    const vectorStore = new InMemoryVectorStore();
    noteRepo = new SQLiteNoteRepository(db, vectorStore);
  });

  test('soft reset: scanned/organized → processed, clears themeIds and relatedNoteIds', async () => {
    await noteRepo.save(
      makeNote('n1', {
        status: 'scanned',
        themeIds: ['t1'],
        relatedNoteIds: ['n2'],
        summary: 'keep',
        topics: ['x'],
        contentVector: [0.1],
      }),
    );
    await noteRepo.save(makeNote('n2', { status: 'organized', themeIds: ['t1'] }));
    await noteRepo.save(makeNote('n3', { status: 'pending' }));

    const { count } = await noteRepo.resetAll(false);

    expect(count).toBe(2);
    const n1 = await noteRepo.findById('n1');
    expect(n1?.status).toBe('processed');
    expect(n1?.themeIds).toEqual([]);
    expect(n1?.relatedNoteIds).toEqual([]);
    expect(n1?.summary).toBe('keep'); // AI fields preserved on soft reset
    expect(n1?.contentVector).toEqual([0.1]);
    const n3 = await noteRepo.findById('n3');
    expect(n3?.status).toBe('pending'); // pending unchanged
  });

  test('full reset: all notes → pending, AI fields cleared, returns all IDs', async () => {
    await noteRepo.save(
      makeNote('n1', { status: 'organized', summary: 'x', contentVector: [0.1], topics: ['t'] }),
    );
    await noteRepo.save(makeNote('n2', { status: 'pending' }));

    const { count, noteIds } = await noteRepo.resetAll(true);

    expect(count).toBe(2);
    expect(noteIds).toEqual(expect.arrayContaining(['n1', 'n2']));
    const n1 = await noteRepo.findById('n1');
    expect(n1?.status).toBe('pending');
    expect(n1?.summary).toBe('');
    expect(n1?.contentVector).toEqual([]);
    expect(n1?.summaryVector).toEqual([]);
  });

  test('soft reset clears note_themes join table', async () => {
    await noteRepo.save(makeNote('n1', { status: 'scanned', themeIds: ['t1'] }));
    await noteRepo.resetAll(false);
    const rows = db.query('SELECT * FROM note_themes').all();
    expect(rows).toHaveLength(0);
  });
});

describe('SQLiteNoteRepository.sourceFile', () => {
  let db: ReturnType<typeof createDatabase>;
  let repo: SQLiteNoteRepository;

  beforeEach(() => {
    db = createDatabase(':memory:');
    repo = new SQLiteNoteRepository(db, new InMemoryVectorStore());
  });

  test('saves and loads sourceFile', async () => {
    const note = makeNote('sf-1', { sourceFile: 'original.txt' });
    await repo.save(note);
    const loaded = await repo.findById('sf-1');
    expect(loaded?.sourceFile).toBe('original.txt');
  });

  test('sourceFile is undefined when not set', async () => {
    const note = makeNote('sf-2');
    await repo.save(note);
    const loaded = await repo.findById('sf-2');
    expect(loaded?.sourceFile).toBeUndefined();
  });
});

describe('Cross-repo bidirectionality', () => {
  let noteRepo: SQLiteNoteRepository;
  let themeRepo: SQLiteThemeRepository;

  beforeEach(() => {
    const db = createDatabase(':memory:');
    const vectorStore = new InMemoryVectorStore();
    noteRepo = new SQLiteNoteRepository(db, vectorStore);
    themeRepo = new SQLiteThemeRepository(db, vectorStore);
  });

  test('note saved with themeId is visible from theme.noteIds', async () => {
    await themeRepo.save(makeTheme('t1', { noteIds: [] }));
    await noteRepo.save(makeNote('n1', { themeIds: ['t1'] }));
    const theme = await themeRepo.findById('t1');
    expect(theme?.noteIds).toContain('n1');
  });

  test('theme saved with noteId is visible from note.themeIds', async () => {
    await noteRepo.save(makeNote('n1', { themeIds: [] }));
    await themeRepo.save(makeTheme('t1', { noteIds: ['n1'] }));
    const note = await noteRepo.findById('n1');
    expect(note?.themeIds).toContain('t1');
  });
});
