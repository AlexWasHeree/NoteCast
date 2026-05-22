import type { INoteRepository } from '../../../domain/note/note.entity';
import { emptyUnifiedProposal, type UnifiedProposal } from '../../../domain/scan/unified.proposal';
import type { IThemeRepository } from '../../../domain/theme/theme.entity';

export async function classifyToUnified(
  scanProposal: { assignments: { noteId: string; themeNames: string[] }[] },
  themeRepository: IThemeRepository,
  noteRepository: INoteRepository,
): Promise<UnifiedProposal> {
  const themes = await themeRepository.findAll();
  const nameToId = new Map(themes.map((t) => [t.name, t.id]));
  const themeIdMap = new Map(themes.map((t) => [t.id, t]));

  const assignments: UnifiedProposal['assignments'] = [];
  const referencedThemeIds = new Set<string>();
  const referencedNoteIds = new Set<string>();

  for (const a of scanProposal.assignments) {
    for (const name of a.themeNames) {
      const themeId = nameToId.get(name);
      if (!themeId) continue;
      assignments.push({ noteId: a.noteId, themeId });
      referencedThemeIds.add(themeId);
      referencedNoteIds.add(a.noteId);
    }
  }

  const contextThemes = [...referencedThemeIds]
    .map((id) => themeIdMap.get(id))
    .filter(Boolean)
    .map((t) => ({ id: t!.id, name: t!.name }));

  const contextNotes = await Promise.all(
    [...referencedNoteIds].map(async (id) => {
      const note = await noteRepository.findById(id);
      return note ? { id: note.id, title: note.title } : null;
    }),
  );

  const proposal = emptyUnifiedProposal();
  proposal.assignments = assignments;
  proposal.context = {
    themes: contextThemes,
    notes: contextNotes.filter(Boolean) as { id: string; title: string }[],
  };
  return proposal;
}
