import type { IQueueProvider } from '../../application/notes/note.usecase';
import type { INoteRepository, Note } from '../../domain/note/note.entity';
import type { IThemeRepository, Theme } from '../../domain/theme/theme.entity';
import { cosine, effectiveSummaryVector } from '../../domain/vector/vector.utils';
import { logger } from '../logger';

const log = logger.child('Queue');

export class InMemoryThemeRepository implements IThemeRepository {
  private themes: Map<string, Theme> = new Map();

  async save(theme: Theme): Promise<void> {
    this.themes.set(theme.id, theme);
  }
  async findById(id: string): Promise<Theme | null> {
    return this.themes.get(id) ?? null;
  }
  async findByName(name: string): Promise<Theme | null> {
    return Array.from(this.themes.values()).find((t) => t.name === name) ?? null;
  }
  async findAll(): Promise<Theme[]> {
    return Array.from(this.themes.values());
  }
  async update(theme: Theme): Promise<void> {
    this.themes.set(theme.id, theme);
  }
  async delete(id: string): Promise<void> {
    this.themes.delete(id);
  }
  async deleteAll(): Promise<number> {
    const count = this.themes.size;
    this.themes.clear();
    return count;
  }
  async knnByThemeVector(vector: number[], k: number, threshold: number): Promise<string[]> {
    const results: { id: string; score: number }[] = [];
    for (const theme of this.themes.values()) {
      if (!theme.descriptionVector || theme.descriptionVector.length === 0) continue;
      const score = cosine(vector, theme.descriptionVector);
      if (score >= threshold) results.push({ id: theme.id, score });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, k).map((r) => r.id);
  }
}

export class InMemoryNoteRepository implements INoteRepository {
  private notes: Map<string, Note> = new Map();

  async save(note: Note): Promise<void> {
    this.notes.set(note.id, note);
  }
  async findById(id: string): Promise<Note | null> {
    return this.notes.get(id) ?? null;
  }
  async findAll(): Promise<Note[]> {
    return Array.from(this.notes.values());
  }
  async findByIds(ids: string[]): Promise<Note[]> {
    return ids.map((id) => this.notes.get(id)).filter((n): n is Note => !!n);
  }
  async findByStatus(status: Note['status']): Promise<Note[]> {
    return Array.from(this.notes.values()).filter((n) => n.status === status);
  }
  async countAllStatuses(): Promise<Record<Note['status'], number>> {
    const counts = { pending: 0, processed: 0, scanned: 0, organized: 0 };
    for (const note of this.notes.values()) {
      counts[note.status] = (counts[note.status] ?? 0) + 1;
    }
    return counts;
  }
  async update(note: Note): Promise<void> {
    this.notes.set(note.id, note);
  }
  async delete(id: string): Promise<void> {
    this.notes.delete(id);
  }
  async resetAll(full: boolean): Promise<{ count: number; noteIds: string[] }> {
    let count = 0;
    const noteIds: string[] = [];
    for (const [id, note] of this.notes) {
      if (full) {
        this.notes.set(id, {
          ...note,
          status: 'pending',
          summary: '',
          topics: [],
          contentVector: [],
          summaryVector: [],
          themeIds: [],
          relatedNoteIds: [],
        });
        noteIds.push(id);
        count++;
      } else {
        if (note.status === 'scanned' || note.status === 'organized') {
          this.notes.set(id, { ...note, status: 'processed', themeIds: [], relatedNoteIds: [] });
          count++;
        } else if (note.status === 'processed') {
          this.notes.set(id, { ...note, themeIds: [], relatedNoteIds: [] });
        }
      }
    }
    return { count, noteIds };
  }
  async knnByContentVector(vector: number[], k: number, threshold: number): Promise<string[]> {
    const results: { id: string; score: number }[] = [];
    for (const note of this.notes.values()) {
      if (note.contentVector.length === 0) continue;
      const score = cosine(vector, note.contentVector);
      if (score >= threshold) results.push({ id: note.id, score });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, k).map((r) => r.id);
  }
  async knnBySummaryVector(vector: number[], k: number, threshold: number): Promise<string[]> {
    const results: { id: string; score: number }[] = [];
    for (const note of this.notes.values()) {
      const v = effectiveSummaryVector(note);
      if (v.length === 0) continue;
      const score = cosine(vector, v);
      if (score >= threshold) results.push({ id: note.id, score });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, k).map((r) => r.id);
  }
}

export class SimpleMemoryQueue implements IQueueProvider {
  private consumers: Array<(id: string) => void | Promise<void>> = [];
  private backlog: string[] = [];
  private draining = false;

  /**
   * Serial drain: one note at a time through all consumers.
   * Avoids hammering Ollama with hundreds of parallel /api/chat calls (empty summaries + still "processed").
   */
  onMessage(callback: (id: string) => void | Promise<void>) {
    this.consumers.push(callback);
  }

  async enqueue(noteId: string): Promise<void> {
    log.debug('Enqueued', { noteId });
    this.backlog.push(noteId);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.backlog.length > 0) {
        const id = this.backlog.shift()!;
        for (const consumer of this.consumers) {
          await Promise.resolve(consumer(id));
        }
      }
    } finally {
      this.draining = false;
      if (this.backlog.length > 0) void this.drain();
    }
  }
}
