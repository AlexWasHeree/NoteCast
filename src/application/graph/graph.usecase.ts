import type { INoteRepository } from '../../domain/note/note.entity';
import { logger } from '../../infrastructure/logger';

const log = logger.child('Graph');

import {
  effectiveSummaryVector,
  GRAPH_THRESHOLD,
  GRAPH_TOP_K,
  topKSimilarBySummary,
  topKSimilarToSummary,
} from '../../domain/vector/vector.utils';

export class NoteGraphUseCase {
  constructor(private noteRepository: INoteRepository) {}

  async build(): Promise<{ notesLinked: number; totalLinks: number }> {
    const notes = await this.noteRepository.findAll();
    const links = topKSimilarBySummary(notes, GRAPH_THRESHOLD, GRAPH_TOP_K);

    let notesLinked = 0;
    let totalLinks = 0;

    for (const note of notes) {
      const related = links.get(note.id) ?? [];
      const current = note.relatedNoteIds ?? [];
      const changed =
        related.length !== current.length || related.some((id, i) => id !== current[i]);
      if (changed) await this.noteRepository.update({ ...note, relatedNoteIds: related });
      if (related.length > 0) notesLinked++;
      totalLinks += related.length;
    }

    log.info('Note graph built', {
      notesLinked,
      totalLinks,
      threshold: GRAPH_THRESHOLD,
      topK: GRAPH_TOP_K,
    });
    return { notesLinked, totalLinks };
  }

  /**
   * Incremental graph update: recalculates links only for the given noteIds
   * and updates any corpus notes whose top-K changed as a result.
   * O(m×n) where m = noteIds.length, n = total notes — avoids full O(n²).
   */
  async buildIncremental(noteIds: string[]): Promise<{ notesUpdated: number }> {
    if (noteIds.length === 0) return { notesUpdated: 0 };

    const allNotes = await this.noteRepository.findAll();
    const noteMap = new Map(allNotes.map((n) => [n.id, n]));
    const targetSet = new Set(noteIds);
    const touched = new Set<string>();

    // 1. Compute links for each target note against the full corpus
    for (const noteId of noteIds) {
      const note = noteMap.get(noteId);
      if (!note || effectiveSummaryVector(note).length === 0) continue;

      const newRelated = topKSimilarToSummary(note, allNotes, GRAPH_THRESHOLD, GRAPH_TOP_K);
      await this.noteRepository.update({ ...note, relatedNoteIds: newRelated });
      touched.add(noteId);

      // 2. For each corpus note that is now similar to this target,
      //    check if target should enter its top-K
      for (const relatedId of newRelated) {
        if (targetSet.has(relatedId)) continue; // will be recomputed in pass 1
        if (touched.has(relatedId)) continue;

        const relatedNote = noteMap.get(relatedId);
        if (!relatedNote) continue;

        const currentRelated = relatedNote.relatedNoteIds ?? [];
        if (currentRelated.includes(noteId)) continue; // already linked

        // Recompute this note's top-K since a new neighbor appeared
        const refreshed = topKSimilarToSummary(relatedNote, allNotes, GRAPH_THRESHOLD, GRAPH_TOP_K);
        if (refreshed.join(',') !== currentRelated.join(',')) {
          await this.noteRepository.update({ ...relatedNote, relatedNoteIds: refreshed });
          touched.add(relatedId);
        }
      }
    }

    log.info('Graph incrementally updated', { touched: touched.size, targets: noteIds.length });
    return { notesUpdated: touched.size };
  }
}
