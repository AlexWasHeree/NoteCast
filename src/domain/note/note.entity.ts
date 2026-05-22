export interface Note {
  id: string;
  title: string;
  content: string;
  status: 'pending' | 'processed' | 'scanned' | 'organized' | 'failed';
  failureReason?: string;
  themeIds?: string[];
  createdAt: Date;
  summary: string;
  topics: string[];
  /** Embedding used by scans (classify, organize, consolidate): title + content + topics. */
  contentVector: number[];
  /** Embedding used only for the related-notes graph: title + summary + topics. */
  summaryVector: number[];
  relatedNoteIds: string[];
  /** Original filename that was ingested, used for Obsidian transclusion. */
  sourceFile?: string;
}

export interface INoteRepository {
  save(note: Note): Promise<void>;
  findById(id: string): Promise<Note | null>;
  findAll(): Promise<Note[]>;
  findByIds(ids: string[]): Promise<Note[]>;
  findByStatus(status: Note['status']): Promise<Note[]>;
  countAllStatuses(): Promise<Record<Note['status'], number>>;
  resetAll(full: boolean): Promise<{ count: number; noteIds: string[] }>;
  update(note: Note): Promise<void>;
  delete(id: string): Promise<void>;
  knnByContentVector(vector: number[], k: number, threshold: number): Promise<string[]>;
  knnBySummaryVector(vector: number[], k: number, threshold: number): Promise<string[]>;
}
