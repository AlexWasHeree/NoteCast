export interface NoteVectors {
  /** Embedding of title + content + topics — used by classify/organize/consolidate. */
  contentVector: number[];
  /** Embedding of title + summary + topics — used by the note graph. */
  summaryVector: number[];
}

export interface IVectorStore {
  // Notes
  upsertNoteVectors(id: string, vectors: NoteVectors): Promise<void>;
  deleteNoteVectors(id: string): Promise<void>;
  resetNoteVectors(): Promise<void>;
  findNoteVectorsByIds(ids: string[]): Promise<Map<string, NoteVectors>>;
  findAllNoteVectors(): Promise<Map<string, NoteVectors>>;
  knnByContentVector(vector: number[], k: number, threshold: number): Promise<string[]>;
  knnBySummaryVector(vector: number[], k: number, threshold: number): Promise<string[]>;

  // Themes
  upsertThemeVector(id: string, descriptionVector: number[]): Promise<void>;
  deleteThemeVector(id: string): Promise<void>;
  resetThemeVectors(): Promise<void>;
  findThemeVectorsByIds(ids: string[]): Promise<Map<string, number[]>>;
  findAllThemeVectors(): Promise<Map<string, number[]>>;
  knnByThemeVector(vector: number[], k: number, threshold: number): Promise<string[]>;
}
