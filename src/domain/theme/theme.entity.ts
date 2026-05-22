export interface Theme {
  id: string;
  name: string;
  description?: string;
  descriptionVector?: number[];
  parentIds: string[];
  noteIds: string[];
  createdAt: Date;
}

export interface IThemeRepository {
  save(theme: Theme): Promise<void>;
  findById(id: string): Promise<Theme | null>;
  findByName(name: string): Promise<Theme | null>;
  findAll(): Promise<Theme[]>;
  update(theme: Theme): Promise<void>;
  delete(id: string): Promise<void>;
  deleteAll(): Promise<number>;
  knnByThemeVector(vector: number[], k: number, threshold: number): Promise<string[]>;
}
