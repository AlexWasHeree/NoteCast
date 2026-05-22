import type { IEmbeddingClient } from '../../../domain/llm/llm.types';
import type { INoteRepository } from '../../../domain/note/note.entity';
import type { UnifiedProposal } from '../../../domain/scan/unified.proposal';
import type { IThemeRepository } from '../../../domain/theme/theme.entity';
import { newId } from '../../../infrastructure/id';
import { logger } from '../../../infrastructure/logger';

const log = logger.child('UnifiedApply');

/**
 * Remove ancestor theme IDs when a more specific descendant is already present.
 * Walks parentIds (multi-parent DAG) using BFS to find ancestry paths.
 */
export function removeAncestorThemeIds(
  themeIds: string[],
  themeMap: Map<string, { parentIds: string[] }>,
): string[] {
  function isAncestorOf(ancestorId: string, descendantId: string): boolean {
    const visited = new Set<string>();
    const queue = [descendantId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      const parents = themeMap.get(current)?.parentIds ?? [];
      for (const pid of parents) {
        if (pid === ancestorId) return true;
        queue.push(pid);
      }
    }
    return false;
  }
  return themeIds.filter(
    (id) => !themeIds.some((other) => other !== id && isAncestorOf(id, other)),
  );
}

export interface ApplyUnifiedResult {
  themesCreated: number;
  themesMerged: number;
  notesMovedBySplits: number;
  notesMovedByMerges: number;
  redistributionsApplied: number;
  removalsApplied: number;
  addParentsApplied: number;
  removeParentsApplied: number;
  assignmentsApplied: number;
  multiAssignmentsApplied: number;
  skipped: number;
}

export async function applyUnifiedProposal(
  proposal: UnifiedProposal,
  noteRepository: INoteRepository,
  themeRepository: IThemeRepository,
  embeddingClient?: IEmbeddingClient,
): Promise<ApplyUnifiedResult> {
  let themesCreated = 0;
  let themesMerged = 0;
  let notesMovedBySplits = 0;
  let notesMovedByMerges = 0;
  let redistributionsApplied = 0;
  let removalsApplied = 0;
  let addParentsApplied = 0;
  let removeParentsApplied = 0;
  let assignmentsApplied = 0;
  let multiAssignmentsApplied = 0;
  let skipped = 0;

  const allThemes = await themeRepository.findAll();
  const themeMap = new Map(allThemes.map((t) => [t.id, t]));

  // 1. createThemes — must run first so new IDs are available for splits/assignments
  for (const entry of proposal.createThemes ?? []) {
    const id = entry.id ?? newId();
    const existing = await themeRepository.findById(id);
    if (existing) {
      skipped++;
      continue;
    }
    const description = entry.description?.trim();
    let descriptionVector: number[] | undefined;
    if (description && embeddingClient) {
      try {
        descriptionVector = await embeddingClient.embed(description);
      } catch (err) {
        log.warn('Failed to embed createTheme description', {
          err: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }
    const theme = {
      id,
      name: entry.name.trim(),
      parentIds: entry.parentIds,
      noteIds: [] as string[],
      createdAt: new Date(),
      ...(description ? { description, ...(descriptionVector ? { descriptionVector } : {}) } : {}),
    };
    await themeRepository.save(theme);
    themeMap.set(id, theme);
    themesCreated++;
  }

  // 2. Removals (empty themes only — skip if has notes or children)
  const currentThemes = await themeRepository.findAll();
  const hasChildrenSet = new Set(currentThemes.flatMap((t) => t.parentIds));
  for (const themeId of proposal.removals) {
    const theme = await themeRepository.findById(themeId);
    if (!theme) {
      skipped++;
      continue;
    }
    if (theme.noteIds.length !== 0) {
      skipped++;
      continue;
    }
    if (hasChildrenSet.has(themeId)) {
      skipped++;
      continue;
    }
    await themeRepository.delete(themeId);
    themeMap.delete(themeId);
    removalsApplied++;
  }

  // 3. Splits — newThemeId must exist (either from createThemes above or already in DB)
  for (const split of proposal.splits) {
    const parentTheme = await themeRepository.findById(split.parentThemeId);
    const subTheme = await themeRepository.findById(split.newThemeId);
    if (!parentTheme || !subTheme) {
      skipped++;
      continue;
    }

    const movedNoteIds: string[] = [];
    for (const noteId of [...new Set(split.noteIds)]) {
      const note = await noteRepository.findById(noteId);
      if (!note) continue;
      const updatedThemeIds = (note.themeIds ?? [])
        .filter((id) => id !== parentTheme.id)
        .concat(subTheme.id);
      await noteRepository.update({ ...note, themeIds: updatedThemeIds });
      movedNoteIds.push(noteId);
    }

    const freshParent = await themeRepository.findById(split.parentThemeId);
    if (freshParent) {
      await themeRepository.update({
        ...freshParent,
        noteIds: freshParent.noteIds.filter((id) => !movedNoteIds.includes(id)),
      });
    }
    const freshSub = await themeRepository.findById(split.newThemeId);
    if (freshSub) {
      await themeRepository.update({
        ...freshSub,
        noteIds: [...new Set([...freshSub.noteIds, ...movedNoteIds])],
      });
    }

    notesMovedBySplits += movedNoteIds.length;
  }

  // 4. Merges
  for (const merge of proposal.merges) {
    const sourceTheme = await themeRepository.findById(merge.sourceThemeId);
    const targetTheme = await themeRepository.findById(merge.targetThemeId);
    if (!sourceTheme || !targetTheme || merge.sourceThemeId === merge.targetThemeId) {
      skipped++;
      continue;
    }
    const newTargetNoteIds = [...new Set([...targetTheme.noteIds, ...sourceTheme.noteIds])];
    await themeRepository.update({ ...targetTheme, noteIds: newTargetNoteIds });
    for (const noteId of sourceTheme.noteIds) {
      const note = await noteRepository.findById(noteId);
      if (!note) continue;
      const updatedThemeIds = (note.themeIds ?? [])
        .filter((id) => id !== sourceTheme.id)
        .concat(targetTheme.id);
      await noteRepository.update({ ...note, themeIds: [...new Set(updatedThemeIds)] });
    }
    await themeRepository.delete(sourceTheme.id);
    themeMap.delete(sourceTheme.id);
    themesMerged++;
    notesMovedByMerges += sourceTheme.noteIds.length;
  }

  // 5. Redistributions
  for (const redist of proposal.redistributions) {
    const note = await noteRepository.findById(redist.noteId);
    const fromTheme = await themeRepository.findById(redist.fromThemeId);
    const toTheme = await themeRepository.findById(redist.toThemeId);
    if (!note || !fromTheme || !toTheme || redist.fromThemeId === redist.toThemeId) {
      skipped++;
      continue;
    }
    if (!(note.themeIds ?? []).includes(redist.fromThemeId)) {
      skipped++;
      continue;
    }

    const rawThemeIds = [
      ...new Set((note.themeIds ?? []).filter((id) => id !== fromTheme.id).concat(toTheme.id)),
    ];
    const cleanThemeIds = removeAncestorThemeIds(rawThemeIds, themeMap);
    const removedAncestorIds = rawThemeIds.filter((id) => !cleanThemeIds.includes(id));
    await noteRepository.update({ ...note, themeIds: cleanThemeIds });

    for (const ancestorId of removedAncestorIds) {
      const anc = await themeRepository.findById(ancestorId);
      if (anc) {
        await themeRepository.update({
          ...anc,
          noteIds: anc.noteIds.filter((id) => id !== redist.noteId),
        });
      }
    }
    const freshFrom = await themeRepository.findById(redist.fromThemeId);
    if (freshFrom) {
      await themeRepository.update({
        ...freshFrom,
        noteIds: freshFrom.noteIds.filter((id) => id !== redist.noteId),
      });
    }
    const freshTo = await themeRepository.findById(redist.toThemeId);
    if (freshTo) {
      await themeRepository.update({
        ...freshTo,
        noteIds: [...new Set([...freshTo.noteIds, redist.noteId])],
      });
    }
    redistributionsApplied++;
  }

  // 6. addParents (with cycle detection)
  for (const conn of proposal.addParents) {
    const theme = await themeRepository.findById(conn.themeId);
    if (!theme) {
      skipped++;
      continue;
    }
    const parentTheme = await themeRepository.findById(conn.parentId);
    if (!parentTheme) {
      skipped++;
      continue;
    }
    if (theme.parentIds.includes(conn.parentId)) {
      skipped++;
      continue;
    }

    // Cycle detection: BFS upward from candidate parent — if themeId reachable, skip
    const parentMap = new Map(Array.from(themeMap.values()).map((t) => [t.id, t.parentIds]));
    let hasCycle = false;
    const visited = new Set<string>();
    const queue = [conn.parentId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === conn.themeId) {
        hasCycle = true;
        break;
      }
      if (visited.has(current)) continue;
      visited.add(current);
      for (const pid of parentMap.get(current) ?? []) queue.push(pid);
    }
    if (hasCycle) {
      skipped++;
      continue;
    }

    const updatedTheme = {
      ...theme,
      parentIds: [...new Set([...theme.parentIds, conn.parentId])],
    };
    await themeRepository.update(updatedTheme);
    themeMap.set(conn.themeId, updatedTheme);

    // Sweep notes in updated theme: some may now violate leaf-only rule
    const freshTheme = themeMap.get(conn.themeId);
    if (freshTheme) {
      for (const noteId of freshTheme.noteIds) {
        const note = await noteRepository.findById(noteId);
        if (!note || (note.themeIds ?? []).length <= 1) continue;
        const cleanThemeIds = removeAncestorThemeIds(note.themeIds!, themeMap);
        if (cleanThemeIds.length === note.themeIds?.length) continue;
        await noteRepository.update({ ...note, themeIds: cleanThemeIds });
        const removedIds = note.themeIds?.filter((id) => !cleanThemeIds.includes(id)) ?? [];
        for (const removedId of removedIds) {
          const removedTheme = await themeRepository.findById(removedId);
          if (removedTheme) {
            await themeRepository.update({
              ...removedTheme,
              noteIds: removedTheme.noteIds.filter((id) => id !== noteId),
            });
          }
        }
      }
    }
    addParentsApplied++;
  }

  // 7. removeParents (guard: never remove last parent)
  for (const conn of proposal.removeParents) {
    const theme = await themeRepository.findById(conn.themeId);
    if (!theme) {
      skipped++;
      continue;
    }
    if (!theme.parentIds.includes(conn.parentId)) {
      skipped++;
      continue;
    }
    if (theme.parentIds.length <= 1) {
      skipped++;
      continue;
    }
    const updatedTheme = {
      ...theme,
      parentIds: theme.parentIds.filter((id) => id !== conn.parentId),
    };
    await themeRepository.update(updatedTheme);
    themeMap.set(conn.themeId, updatedTheme);
    removeParentsApplied++;
  }

  // 8. Assignments (classify: processed → scanned)
  for (const a of proposal.assignments) {
    const note = await noteRepository.findById(a.noteId);
    const theme = await themeRepository.findById(a.themeId);
    if (!note || !theme || note.status !== 'processed') {
      skipped++;
      continue;
    }

    const rawThemeIds = [...new Set([...(note.themeIds ?? []), a.themeId])];
    const themeIds = removeAncestorThemeIds(rawThemeIds, themeMap);
    await noteRepository.update({ ...note, themeIds, status: 'scanned' });

    const freshTheme = await themeRepository.findById(a.themeId);
    if (freshTheme && !freshTheme.noteIds.includes(a.noteId)) {
      await themeRepository.update({
        ...freshTheme,
        noteIds: [...freshTheme.noteIds, a.noteId],
      });
    }
    assignmentsApplied++;
  }

  // 9. multiAssignments
  for (const ma of proposal.multiAssignments) {
    const note = await noteRepository.findById(ma.noteId);
    const theme = await themeRepository.findById(ma.themeId);
    if (!note || !theme) {
      skipped++;
      continue;
    }
    if ((note.themeIds ?? []).includes(ma.themeId)) {
      skipped++;
      continue;
    }

    const rawThemeIds = [...new Set([...(note.themeIds ?? []), ma.themeId])];
    const cleanThemeIds = removeAncestorThemeIds(rawThemeIds, themeMap);
    await noteRepository.update({ ...note, themeIds: cleanThemeIds });

    if (!theme.noteIds.includes(ma.noteId)) {
      await themeRepository.update({ ...theme, noteIds: [...theme.noteIds, ma.noteId] });
    }

    const removedIds = rawThemeIds.filter((id) => !cleanThemeIds.includes(id));
    for (const ancestorId of removedIds) {
      const anc = await themeRepository.findById(ancestorId);
      if (anc) {
        await themeRepository.update({
          ...anc,
          noteIds: anc.noteIds.filter((id) => id !== ma.noteId),
        });
      }
    }
    multiAssignmentsApplied++;
  }

  return {
    themesCreated,
    themesMerged,
    notesMovedBySplits,
    notesMovedByMerges,
    redistributionsApplied,
    removalsApplied,
    addParentsApplied,
    removeParentsApplied,
    assignmentsApplied,
    multiAssignmentsApplied,
    skipped,
  };
}
