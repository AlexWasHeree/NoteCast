import type { Database, Table } from '@lancedb/lancedb';
import * as lancedb from '@lancedb/lancedb';
import type { IVectorStore, NoteVectors } from '../../domain/vector/vector.store';
import { logger } from '../logger';

/** Default embedding dimension (nomic-embed-text = 768). Override via LANCEDB_DIM env var. */
const DEFAULT_DIM = Number(process.env.LANCEDB_DIM) || 768;

const log = logger.child('LanceDB');

async function storedDim(table: Table, vectorColumn: string): Promise<number | undefined> {
  const schema = await table.schema();
  const field = schema.fields.find((f: any) => f.name === vectorColumn);
  return (field?.type as any)?.listSize as number | undefined;
}

async function openOrRecreate(
  db: Database,
  tableNames: string[],
  tableName: string,
  dim: number,
  initRow: Record<string, unknown>,
  vectorColumn: string,
): Promise<Table> {
  if (tableNames.includes(tableName)) {
    const existing = await db.openTable(tableName);
    const actual = await storedDim(existing, vectorColumn);
    if (actual !== undefined && actual !== dim) {
      log.warn(
        `${tableName}: stored dim=${actual} != requested dim=${dim} — dropping and recreating. All vectors will be recomputed on next processing.`,
      );
      await db.dropTable(tableName);
    } else {
      return existing;
    }
  }
  return db.createTable(tableName, [{ id: '__init__', ...initRow }]).then(async (t) => {
    await t.delete("id = '__init__'");
    return t;
  });
}

export class LanceDBVectorStore implements IVectorStore {
  private constructor(
    private readonly noteTable: Table,
    private readonly themeTable: Table,
  ) {}

  static async open(path: string, dim = DEFAULT_DIM): Promise<LanceDBVectorStore> {
    const db = await lancedb.connect(path);
    const tableNames = await db.tableNames();

    const noteTable = await openOrRecreate(
      db,
      tableNames,
      'note_vectors',
      dim,
      { content_vector: Array(dim).fill(0), summary_vector: Array(dim).fill(0) },
      'content_vector',
    );

    const themeTable = await openOrRecreate(
      db,
      tableNames,
      'theme_vectors',
      dim,
      { description_vector: Array(dim).fill(0) },
      'description_vector',
    );

    return new LanceDBVectorStore(noteTable, themeTable);
  }

  // ── Notes ──────────────────────────────────────────────────────────────────

  async upsertNoteVectors(id: string, vectors: NoteVectors): Promise<void> {
    await this.noteTable
      .mergeInsert('id')
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute([
        {
          id,
          content_vector: vectors.contentVector,
          summary_vector: vectors.summaryVector,
        },
      ]);
  }

  async deleteNoteVectors(id: string): Promise<void> {
    await this.noteTable.delete(`id = '${id}'`);
  }

  async resetNoteVectors(): Promise<void> {
    const count = await this.noteTable.countRows();
    if (count > 0) {
      await this.noteTable.delete('id IS NOT NULL');
    }
  }

  async findNoteVectorsByIds(ids: string[]): Promise<Map<string, NoteVectors>> {
    if (ids.length === 0) return new Map();
    const idList = ids.map((id) => `'${id}'`).join(', ');
    const rows = await this.noteTable
      .query()
      .where(`id IN (${idList})`)
      .select(['id', 'content_vector', 'summary_vector'])
      .toArray();
    return this._rowsToNoteVectorMap(rows);
  }

  async findAllNoteVectors(): Promise<Map<string, NoteVectors>> {
    const rows = await this.noteTable
      .query()
      .select(['id', 'content_vector', 'summary_vector'])
      .toArray();
    return this._rowsToNoteVectorMap(rows);
  }

  async knnByContentVector(vector: number[], k: number, threshold: number): Promise<string[]> {
    if (vector.length === 0) return [];
    const count = await this.noteTable.countRows();
    if (count === 0) return [];
    const results = await this.noteTable
      .vectorSearch(vector)
      .column('content_vector')
      .distanceType('cosine')
      .limit(k)
      .toArray();
    return results
      .filter((r: any) => (r._distance as number) <= 1 - threshold)
      .map((r: any) => r.id as string);
  }

  async knnBySummaryVector(vector: number[], k: number, threshold: number): Promise<string[]> {
    if (vector.length === 0) return [];
    const count = await this.noteTable.countRows();
    if (count === 0) return [];
    const results = await this.noteTable
      .vectorSearch(vector)
      .column('summary_vector')
      .distanceType('cosine')
      .limit(k)
      .toArray();
    return results
      .filter((r: any) => (r._distance as number) <= 1 - threshold)
      .map((r: any) => r.id as string);
  }

  private _rowsToNoteVectorMap(rows: any[]): Map<string, NoteVectors> {
    const result = new Map<string, NoteVectors>();
    for (const row of rows) {
      result.set(row.id as string, {
        contentVector: Array.from(row.content_vector as Float32Array),
        summaryVector: Array.from(row.summary_vector as Float32Array),
      });
    }
    return result;
  }

  // ── Themes ─────────────────────────────────────────────────────────────────

  async upsertThemeVector(id: string, descriptionVector: number[]): Promise<void> {
    await this.themeTable
      .mergeInsert('id')
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute([{ id, description_vector: descriptionVector }]);
  }

  async deleteThemeVector(id: string): Promise<void> {
    await this.themeTable.delete(`id = '${id}'`);
  }

  async resetThemeVectors(): Promise<void> {
    const count = await this.themeTable.countRows();
    if (count > 0) {
      await this.themeTable.delete('id IS NOT NULL');
    }
  }

  async findThemeVectorsByIds(ids: string[]): Promise<Map<string, number[]>> {
    if (ids.length === 0) return new Map();
    const idList = ids.map((id) => `'${id}'`).join(', ');
    const rows = await this.themeTable
      .query()
      .where(`id IN (${idList})`)
      .select(['id', 'description_vector'])
      .toArray();
    return this._rowsToThemeVectorMap(rows);
  }

  async findAllThemeVectors(): Promise<Map<string, number[]>> {
    const rows = await this.themeTable.query().select(['id', 'description_vector']).toArray();
    return this._rowsToThemeVectorMap(rows);
  }

  async knnByThemeVector(vector: number[], k: number, threshold: number): Promise<string[]> {
    if (vector.length === 0) return [];
    const count = await this.themeTable.countRows();
    if (count === 0) return [];
    const results = await this.themeTable
      .vectorSearch(vector)
      .column('description_vector')
      .distanceType('cosine')
      .limit(k)
      .toArray();
    return results
      .filter((r: any) => (r._distance as number) <= 1 - threshold)
      .map((r: any) => r.id as string);
  }

  private _rowsToThemeVectorMap(rows: any[]): Map<string, number[]> {
    const result = new Map<string, number[]>();
    for (const row of rows) {
      result.set(row.id as string, Array.from(row.description_vector as Float32Array));
    }
    return result;
  }
}
