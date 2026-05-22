import type { INoteRepository } from '../../../domain/note/note.entity';
import type { StructureProposal } from '../../../domain/scan/scan.types';
import { emptyUnifiedProposal, type UnifiedProposal } from '../../../domain/scan/unified.proposal';
import type { IThemeRepository } from '../../../domain/theme/theme.entity';
import { newId } from '../../../infrastructure/id';

export async function consolidateToUnified(
  structureProposal: StructureProposal,
  themeRepository: IThemeRepository,
  noteRepository: INoteRepository,
): Promise<UnifiedProposal> {
  const themes = await themeRepository.findAll();
  const themeIdMap = new Map(themes.map((t) => [t.id, t]));

  const proposal = emptyUnifiedProposal();
  const referencedThemeIds = new Set<string>();
  const referencedNoteIds = new Set<string>();

  for (const split of structureProposal.splits) {
    const subId = newId();
    proposal.createThemes.push({
      id: subId,
      name: split.newSubTheme.name,
      ...(split.newSubTheme.description ? { description: split.newSubTheme.description } : {}),
      parentIds: [split.parentThemeId],
    });
    proposal.splits.push({
      parentThemeId: split.parentThemeId,
      newThemeId: subId,
      noteIds: split.noteIds,
    });
    referencedThemeIds.add(split.parentThemeId);
    proposal.context.themes.push({ id: subId, name: split.newSubTheme.name, isNew: true });
    for (const nid of split.noteIds) referencedNoteIds.add(nid);
  }
  for (const merge of structureProposal.merges ?? []) {
    proposal.merges.push(merge);
    referencedThemeIds.add(merge.sourceThemeId);
    referencedThemeIds.add(merge.targetThemeId);
  }
  for (const redist of structureProposal.redistributions) {
    proposal.redistributions.push(redist);
    referencedThemeIds.add(redist.fromThemeId);
    referencedThemeIds.add(redist.toThemeId);
    referencedNoteIds.add(redist.noteId);
  }
  for (const id of structureProposal.removals ?? []) {
    proposal.removals.push(id);
    referencedThemeIds.add(id);
  }
  for (const conn of structureProposal.addParents ?? []) {
    proposal.addParents.push(conn);
    referencedThemeIds.add(conn.themeId);
    referencedThemeIds.add(conn.parentId);
  }
  for (const conn of structureProposal.removeParents ?? []) {
    proposal.removeParents.push(conn);
    referencedThemeIds.add(conn.themeId);
    referencedThemeIds.add(conn.parentId);
  }
  for (const ma of structureProposal.multiAssignments ?? []) {
    proposal.multiAssignments.push(ma);
    referencedThemeIds.add(ma.themeId);
    referencedNoteIds.add(ma.noteId);
  }

  const existingContextThemeIds = [...referencedThemeIds].filter(
    (id) => !proposal.context.themes.some((t) => t.id === id),
  );
  for (const id of existingContextThemeIds) {
    const t = themeIdMap.get(id);
    if (t) proposal.context.themes.push({ id: t.id, name: t.name });
  }
  const contextNotes = await Promise.all(
    [...referencedNoteIds].map(async (id) => {
      const note = await noteRepository.findById(id);
      return note ? { id: note.id, title: note.title } : null;
    }),
  );
  proposal.context.notes = contextNotes.filter(Boolean) as { id: string; title: string }[];
  return proposal;
}
