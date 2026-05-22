import type { IEmbeddingClient } from '../../domain/llm/llm.types';
import type { INoteRepository } from '../../domain/note/note.entity';
import type { IThemeRepository, Theme } from '../../domain/theme/theme.entity';
import { newId } from '../../infrastructure/id';

export class CreateThemeUseCase {
  constructor(
    private themeRepository: IThemeRepository,
    private embeddingClient: IEmbeddingClient,
  ) {}

  async execute(input: { name: string; parentId?: string; description?: string }): Promise<Theme> {
    const existing = await this.themeRepository.findByName(input.name);
    if (existing) throw new Error(`Theme already exists: ${input.name}`);

    if (input.parentId) {
      const parent = await this.themeRepository.findById(input.parentId);
      if (!parent) throw new Error(`Parent theme not found: ${input.parentId}`);
    }

    let descriptionVector: number[] | undefined;
    if (input.description) {
      descriptionVector = await this.embeddingClient.embed(input.description);
    }

    const theme: Theme = {
      id: newId(),
      name: input.name,
      description: input.description,
      descriptionVector,
      parentIds: input.parentId ? [input.parentId] : [],
      noteIds: [],
      createdAt: new Date(),
    };

    await this.themeRepository.save(theme);
    return theme;
  }
}

export class DeleteThemeUseCase {
  constructor(
    private themeRepository: IThemeRepository,
    private noteRepository: INoteRepository,
  ) {}

  async execute(
    id: string,
  ): Promise<{ deletedId: string; notesRerouted: number; childrenRerouted: number }> {
    const theme = await this.themeRepository.findById(id);
    if (!theme) throw new Error(`Theme not found: ${id}`);

    for (const noteId of theme.noteIds) {
      const note = await this.noteRepository.findById(noteId);
      if (!note) continue;

      const newThemeIds = note.themeIds.filter((t) => t !== id);
      const rerouteTo = theme.parentIds.length > 0 ? theme.parentIds[0] : null;
      if (rerouteTo && !newThemeIds.includes(rerouteTo)) {
        newThemeIds.push(rerouteTo);
        const parentTheme = await this.themeRepository.findById(rerouteTo);
        if (parentTheme && !parentTheme.noteIds.includes(noteId)) {
          await this.themeRepository.update({
            ...parentTheme,
            noteIds: [...parentTheme.noteIds, noteId],
          });
        }
      }

      await this.noteRepository.update({ ...note, themeIds: newThemeIds });
    }

    const allThemes = await this.themeRepository.findAll();
    const children = allThemes.filter((t) => t.parentIds.includes(id));
    for (const child of children) {
      const parentIds = child.parentIds.filter((p) => p !== id);
      for (const p of theme.parentIds) {
        if (!parentIds.includes(p)) parentIds.push(p);
      }
      await this.themeRepository.update({ ...child, parentIds });
    }

    await this.themeRepository.delete(id);

    return {
      deletedId: id,
      notesRerouted: theme.noteIds.length,
      childrenRerouted: children.length,
    };
  }
}

export class ListThemesUseCase {
  constructor(private themeRepository: IThemeRepository) {}

  async execute(): Promise<Theme[]> {
    return this.themeRepository.findAll();
  }
}

export class AssignNoteToThemeUseCase {
  constructor(
    private noteRepository: INoteRepository,
    private themeRepository: IThemeRepository,
  ) {}

  async execute(noteId: string, themeId: string): Promise<void> {
    const note = await this.noteRepository.findById(noteId);
    if (!note) throw new Error(`Note not found: ${noteId}`);
    const theme = await this.themeRepository.findById(themeId);
    if (!theme) throw new Error(`Theme not found: ${themeId}`);

    if (!note.themeIds?.includes(themeId)) {
      await this.noteRepository.update({ ...note, themeIds: [...(note.themeIds ?? []), themeId] });
    }
    if (!theme.noteIds.includes(noteId)) {
      await this.themeRepository.update({ ...theme, noteIds: [...theme.noteIds, noteId] });
    }
  }
}

export class RemoveNoteFromThemeUseCase {
  constructor(
    private noteRepository: INoteRepository,
    private themeRepository: IThemeRepository,
  ) {}

  async execute(noteId: string, themeId: string): Promise<void> {
    const note = await this.noteRepository.findById(noteId);
    if (!note) throw new Error(`Note not found: ${noteId}`);
    const theme = await this.themeRepository.findById(themeId);
    if (!theme) throw new Error(`Theme not found: ${themeId}`);

    if (note.themeIds?.includes(themeId)) {
      await this.noteRepository.update({
        ...note,
        themeIds: (note.themeIds ?? []).filter((id) => id !== themeId),
      });
    }
    if (theme.noteIds.includes(noteId)) {
      await this.themeRepository.update({
        ...theme,
        noteIds: theme.noteIds.filter((id) => id !== noteId),
      });
    }
  }
}

export class UpdateThemeUseCase {
  constructor(
    private themeRepository: IThemeRepository,
    private embeddingClient: IEmbeddingClient,
  ) {}

  async execute(
    id: string,
    fields: { name?: string; description?: string; parentIds?: string[] },
  ): Promise<Theme> {
    const theme = await this.themeRepository.findById(id);
    if (!theme) throw new Error(`Theme not found: ${id}`);

    if (fields.name !== undefined && fields.name !== theme.name) {
      const existing = await this.themeRepository.findByName(fields.name);
      if (existing && existing.id !== id) throw new Error(`Theme already exists: ${fields.name}`);
    }

    let newParentIds = theme.parentIds;
    if (fields.parentIds !== undefined) {
      for (const pid of fields.parentIds) {
        const parent = await this.themeRepository.findById(pid);
        if (!parent) throw new Error(`Parent theme not found: ${pid}`);
      }
      const descendants = await this._collectDescendants(id);
      for (const pid of fields.parentIds) {
        if (descendants.has(pid)) {
          throw new Error(`cycle: ${pid} is a descendant of ${id}`);
        }
      }
      newParentIds = fields.parentIds;
    }

    const newDescription =
      fields.description !== undefined ? fields.description : theme.description;
    let newDescriptionVector = theme.descriptionVector;
    if (fields.description !== undefined && fields.description !== theme.description) {
      newDescriptionVector = await this.embeddingClient.embed(fields.description);
    }

    const updated: Theme = {
      ...theme,
      name: fields.name ?? theme.name,
      description: newDescription,
      descriptionVector: newDescriptionVector,
      parentIds: newParentIds,
    };
    await this.themeRepository.update(updated);
    return updated;
  }

  private async _collectDescendants(id: string): Promise<Set<string>> {
    const all = await this.themeRepository.findAll();
    const childrenOf = new Map<string, string[]>();
    for (const t of all) {
      for (const pid of t.parentIds) {
        if (!childrenOf.has(pid)) childrenOf.set(pid, []);
        childrenOf.get(pid)!.push(t.id);
      }
    }
    const visited = new Set<string>();
    const queue = [id];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const child of childrenOf.get(cur) ?? []) {
        if (!visited.has(child)) {
          visited.add(child);
          queue.push(child);
        }
      }
    }
    return visited;
  }
}

export class MergeThemesUseCase {
  constructor(
    private themeRepository: IThemeRepository,
    private noteRepository: INoteRepository,
  ) {}

  async execute(
    sourceId: string,
    targetId: string,
  ): Promise<{ deletedId: string; notesMoved: number; childrenRerouted: number }> {
    const source = await this.themeRepository.findById(sourceId);
    if (!source) throw new Error(`Source theme not found: ${sourceId}`);
    const target = await this.themeRepository.findById(targetId);
    if (!target) throw new Error(`Target theme not found: ${targetId}`);
    if (sourceId === targetId) throw new Error('source and target are the same theme');

    let notesMoved = 0;
    const updatedTarget = { ...target };

    for (const noteId of source.noteIds) {
      const note = await this.noteRepository.findById(noteId);
      if (!note) continue;
      const newThemeIds = (note.themeIds ?? []).filter((id) => id !== sourceId);
      if (!newThemeIds.includes(targetId)) {
        newThemeIds.push(targetId);
        notesMoved++;
      }
      await this.noteRepository.update({ ...note, themeIds: newThemeIds });
      if (!updatedTarget.noteIds.includes(noteId)) {
        updatedTarget.noteIds = [...updatedTarget.noteIds, noteId];
      }
    }
    await this.themeRepository.update(updatedTarget);

    const all = await this.themeRepository.findAll();
    let childrenRerouted = 0;
    for (const t of all) {
      if (t.parentIds.includes(sourceId)) {
        const newParentIds = t.parentIds.filter((p) => p !== sourceId);
        if (!newParentIds.includes(targetId)) newParentIds.push(targetId);
        await this.themeRepository.update({ ...t, parentIds: newParentIds });
        childrenRerouted++;
      }
    }

    await this.themeRepository.delete(sourceId);
    return { deletedId: sourceId, notesMoved, childrenRerouted };
  }
}
