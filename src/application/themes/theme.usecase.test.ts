import { beforeEach, describe, expect, test } from 'bun:test';
import type { IEmbeddingClient } from '../../domain/llm/llm.types';
import type { Note } from '../../domain/note/note.entity';
import type { Theme } from '../../domain/theme/theme.entity';
import {
  InMemoryNoteRepository,
  InMemoryThemeRepository,
} from '../../infrastructure/notes/adapters';
import {
  AssignNoteToThemeUseCase,
  CreateThemeUseCase,
  DeleteThemeUseCase,
  ListThemesUseCase,
  MergeThemesUseCase,
  RemoveNoteFromThemeUseCase,
  UpdateThemeUseCase,
} from './theme.usecase';

function makeTheme(overrides: Partial<Theme> = {}): Theme {
  return {
    id: 't1',
    name: 'Test Theme',
    parentIds: [],
    noteIds: [],
    createdAt: new Date(),
    ...overrides,
  };
}

const noopEmbed: IEmbeddingClient = { embed: async () => [] };
const trackEmbed = () => {
  let called = false;
  const client: IEmbeddingClient = {
    embed: async () => {
      called = true;
      return [0.1, 0.2];
    },
  };
  return { client, wasCalled: () => called };
};

describe('CreateThemeUseCase', () => {
  let themeRepo: InMemoryThemeRepository;
  let useCase: CreateThemeUseCase;

  beforeEach(() => {
    themeRepo = new InMemoryThemeRepository();
    useCase = new CreateThemeUseCase(themeRepo, noopEmbed);
  });

  test('creates a root theme with name only', async () => {
    const theme = await useCase.execute({ name: 'Science' });
    expect(theme.name).toBe('Science');
    expect(theme.parentIds).toEqual([]);
    expect(theme.noteIds).toEqual([]);
    expect(theme.id).toBeTruthy();
  });

  test('persists theme to repository', async () => {
    const theme = await useCase.execute({ name: 'Science' });
    const found = await themeRepo.findById(theme.id);
    expect(found?.name).toBe('Science');
  });

  test('throws if name already exists', async () => {
    await themeRepo.save(makeTheme({ name: 'Science' }));
    await expect(useCase.execute({ name: 'Science' })).rejects.toThrow('Theme already exists');
  });

  test('throws if parentId does not exist', async () => {
    await expect(useCase.execute({ name: 'Sub', parentId: 'nonexistent' })).rejects.toThrow(
      'Parent theme not found',
    );
  });

  test('sets parentIds when parentId provided', async () => {
    await themeRepo.save(makeTheme({ id: 'p1', name: 'Parent' }));
    const theme = await useCase.execute({ name: 'Child', parentId: 'p1' });
    expect(theme.parentIds).toEqual(['p1']);
  });

  test('does not call embed when no description', async () => {
    const tracker = trackEmbed();
    const uc = new CreateThemeUseCase(themeRepo, tracker.client);
    await uc.execute({ name: 'Science' });
    expect(tracker.wasCalled()).toBe(false);
  });

  test('calls embed and stores descriptionVector when description provided', async () => {
    const tracker = trackEmbed();
    const uc = new CreateThemeUseCase(themeRepo, tracker.client);
    const theme = await uc.execute({ name: 'Science', description: 'Natural sciences' });
    expect(tracker.wasCalled()).toBe(true);
    expect(theme.descriptionVector).toEqual([0.1, 0.2]);
    expect(theme.description).toBe('Natural sciences');
  });
});

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: 'n1',
    title: 'Test Note',
    content: 'content',
    status: 'organized',
    themeIds: [],
    createdAt: new Date(),
    summary: '',
    topics: [],
    contentVector: [],
    summaryVector: [],
    relatedNoteIds: [],
    ...overrides,
  };
}

describe('DeleteThemeUseCase', () => {
  let themeRepo: InMemoryThemeRepository;
  let noteRepo: InMemoryNoteRepository;
  let useCase: DeleteThemeUseCase;

  beforeEach(() => {
    themeRepo = new InMemoryThemeRepository();
    noteRepo = new InMemoryNoteRepository();
    useCase = new DeleteThemeUseCase(themeRepo, noteRepo);
  });

  test('throws if theme not found', async () => {
    await expect(useCase.execute('nonexistent')).rejects.toThrow('Theme not found');
  });

  test('deletes theme from repository', async () => {
    await themeRepo.save(makeTheme({ id: 't1', name: 'T1' }));
    await useCase.execute('t1');
    expect(await themeRepo.findById('t1')).toBeNull();
  });

  test('reroutes notes to first parent on delete', async () => {
    await themeRepo.save(makeTheme({ id: 'parent', name: 'Parent', noteIds: [] }));
    await themeRepo.save(
      makeTheme({ id: 'child', name: 'Child', parentIds: ['parent'], noteIds: ['n1'] }),
    );
    await noteRepo.save(makeNote({ id: 'n1', themeIds: ['child'] }));

    await useCase.execute('child');

    const note = await noteRepo.findById('n1');
    expect(note?.themeIds).not.toContain('child');
    expect(note?.themeIds).toContain('parent');

    const parent = await themeRepo.findById('parent');
    expect(parent?.noteIds).toContain('n1');
  });

  test('unlinks notes from root theme (no parent to reroute to)', async () => {
    await themeRepo.save(makeTheme({ id: 't1', name: 'Root', parentIds: [], noteIds: ['n1'] }));
    await noteRepo.save(makeNote({ id: 'n1', themeIds: ['t1'] }));

    await useCase.execute('t1');

    const note = await noteRepo.findById('n1');
    expect(note?.themeIds).toEqual([]);
  });

  test('reroutes children to grandparent on delete', async () => {
    await themeRepo.save(makeTheme({ id: 'grand', name: 'Grand' }));
    await themeRepo.save(makeTheme({ id: 'parent', name: 'Parent', parentIds: ['grand'] }));
    await themeRepo.save(makeTheme({ id: 'child', name: 'Child', parentIds: ['parent'] }));

    await useCase.execute('parent');

    const child = await themeRepo.findById('child');
    expect(child?.parentIds).not.toContain('parent');
    expect(child?.parentIds).toContain('grand');
  });

  test('child becomes root when deleted theme was root', async () => {
    await themeRepo.save(makeTheme({ id: 'root', name: 'Root', parentIds: [] }));
    await themeRepo.save(makeTheme({ id: 'child', name: 'Child', parentIds: ['root'] }));

    await useCase.execute('root');

    const child = await themeRepo.findById('child');
    expect(child?.parentIds).toEqual([]);
  });

  test('returns correct counts', async () => {
    await themeRepo.save(makeTheme({ id: 'parent', name: 'Parent' }));
    await themeRepo.save(
      makeTheme({ id: 't1', name: 'T1', parentIds: ['parent'], noteIds: ['n1', 'n2'] }),
    );
    await themeRepo.save(makeTheme({ id: 'child', name: 'Child', parentIds: ['t1'] }));
    await noteRepo.save(makeNote({ id: 'n1', themeIds: ['t1'] }));
    await noteRepo.save(makeNote({ id: 'n2', themeIds: ['t1'] }));

    const result = await useCase.execute('t1');

    expect(result.deletedId).toBe('t1');
    expect(result.notesRerouted).toBe(2);
    expect(result.childrenRerouted).toBe(1);
  });
});

describe('ListThemesUseCase', () => {
  test('returns empty array when no themes exist', async () => {
    const repo = new InMemoryThemeRepository();
    const useCase = new ListThemesUseCase(repo);
    const result = await useCase.execute();
    expect(result).toEqual([]);
  });

  test('returns all saved themes', async () => {
    const repo = new InMemoryThemeRepository();
    await repo.save(makeTheme({ id: 't1', name: 'A' }));
    await repo.save(makeTheme({ id: 't2', name: 'B' }));
    const useCase = new ListThemesUseCase(repo);
    const result = await useCase.execute();
    expect(result).toHaveLength(2);
    expect(result.map((t) => t.name).sort()).toEqual(['A', 'B']);
  });
});

describe('AssignNoteToThemeUseCase', () => {
  let themeRepo: InMemoryThemeRepository;
  let noteRepo: InMemoryNoteRepository;
  let useCase: AssignNoteToThemeUseCase;

  beforeEach(() => {
    themeRepo = new InMemoryThemeRepository();
    noteRepo = new InMemoryNoteRepository();
    useCase = new AssignNoteToThemeUseCase(noteRepo, themeRepo);
  });

  test('throws if note not found', async () => {
    await themeRepo.save(makeTheme({ id: 't1', name: 'T1' }));
    await expect(useCase.execute('missing', 't1')).rejects.toThrow('Note not found');
  });

  test('throws if theme not found', async () => {
    await noteRepo.save(makeNote({ id: 'n1' }));
    await expect(useCase.execute('n1', 'missing')).rejects.toThrow('Theme not found');
  });

  test('adds themeId to note.themeIds', async () => {
    await themeRepo.save(makeTheme({ id: 't1', name: 'T1' }));
    await noteRepo.save(makeNote({ id: 'n1', themeIds: [] }));
    await useCase.execute('n1', 't1');
    const note = await noteRepo.findById('n1');
    expect(note?.themeIds).toContain('t1');
  });

  test('adds noteId to theme.noteIds', async () => {
    await themeRepo.save(makeTheme({ id: 't1', name: 'T1' }));
    await noteRepo.save(makeNote({ id: 'n1', themeIds: [] }));
    await useCase.execute('n1', 't1');
    const theme = await themeRepo.findById('t1');
    expect(theme?.noteIds).toContain('n1');
  });

  test('is idempotent — no duplicates on second assign', async () => {
    await themeRepo.save(makeTheme({ id: 't1', name: 'T1' }));
    await noteRepo.save(makeNote({ id: 'n1', themeIds: [] }));
    await useCase.execute('n1', 't1');
    await useCase.execute('n1', 't1');
    const note = await noteRepo.findById('n1');
    const theme = await themeRepo.findById('t1');
    expect(note?.themeIds?.filter((id) => id === 't1')).toHaveLength(1);
    expect(theme?.noteIds?.filter((id) => id === 'n1')).toHaveLength(1);
  });
});

describe('RemoveNoteFromThemeUseCase', () => {
  let themeRepo: InMemoryThemeRepository;
  let noteRepo: InMemoryNoteRepository;
  let useCase: RemoveNoteFromThemeUseCase;

  beforeEach(() => {
    themeRepo = new InMemoryThemeRepository();
    noteRepo = new InMemoryNoteRepository();
    useCase = new RemoveNoteFromThemeUseCase(noteRepo, themeRepo);
  });

  test('throws if note not found', async () => {
    await themeRepo.save(makeTheme({ id: 't1', name: 'T1' }));
    await expect(useCase.execute('missing', 't1')).rejects.toThrow('Note not found');
  });

  test('throws if theme not found', async () => {
    await noteRepo.save(makeNote({ id: 'n1' }));
    await expect(useCase.execute('n1', 'missing')).rejects.toThrow('Theme not found');
  });

  test('removes themeId from note.themeIds', async () => {
    await themeRepo.save(makeTheme({ id: 't1', name: 'T1', noteIds: ['n1'] }));
    await noteRepo.save(makeNote({ id: 'n1', themeIds: ['t1'] }));
    await useCase.execute('n1', 't1');
    const note = await noteRepo.findById('n1');
    expect(note?.themeIds).not.toContain('t1');
  });

  test('removes noteId from theme.noteIds', async () => {
    await themeRepo.save(makeTheme({ id: 't1', name: 'T1', noteIds: ['n1'] }));
    await noteRepo.save(makeNote({ id: 'n1', themeIds: ['t1'] }));
    await useCase.execute('n1', 't1');
    const theme = await themeRepo.findById('t1');
    expect(theme?.noteIds).not.toContain('n1');
  });

  test('is a no-op if note is not assigned to theme', async () => {
    await themeRepo.save(makeTheme({ id: 't1', name: 'T1', noteIds: [] }));
    await noteRepo.save(makeNote({ id: 'n1', themeIds: [] }));
    await expect(useCase.execute('n1', 't1')).resolves.toBeUndefined();
  });
});

describe('UpdateThemeUseCase', () => {
  let themeRepo: InMemoryThemeRepository;
  let useCase: UpdateThemeUseCase;

  beforeEach(() => {
    themeRepo = new InMemoryThemeRepository();
    useCase = new UpdateThemeUseCase(themeRepo, noopEmbed);
  });

  test('throws if theme not found', async () => {
    await expect(useCase.execute('missing', { name: 'New' })).rejects.toThrow('Theme not found');
  });

  test('throws if new name already taken by another theme', async () => {
    await themeRepo.save(makeTheme({ id: 't1', name: 'Alpha' }));
    await themeRepo.save(makeTheme({ id: 't2', name: 'Beta' }));
    await expect(useCase.execute('t1', { name: 'Beta' })).rejects.toThrow('Theme already exists');
  });

  test('renames the theme', async () => {
    await themeRepo.save(makeTheme({ id: 't1', name: 'Old' }));
    await useCase.execute('t1', { name: 'New' });
    const theme = await themeRepo.findById('t1');
    expect(theme?.name).toBe('New');
  });

  test('updates description and re-embeds', async () => {
    const tracker = trackEmbed();
    const uc = new UpdateThemeUseCase(themeRepo, tracker.client);
    await themeRepo.save(makeTheme({ id: 't1', name: 'T1' }));
    await uc.execute('t1', { description: 'New desc' });
    const theme = await themeRepo.findById('t1');
    expect(theme?.description).toBe('New desc');
    expect(theme?.descriptionVector).toEqual([0.1, 0.2]);
    expect(tracker.wasCalled()).toBe(true);
  });

  test('does not re-embed when description unchanged', async () => {
    const tracker = trackEmbed();
    const uc = new UpdateThemeUseCase(themeRepo, tracker.client);
    await themeRepo.save(makeTheme({ id: 't1', name: 'T1', description: 'Same' }));
    await uc.execute('t1', { description: 'Same' });
    expect(tracker.wasCalled()).toBe(false);
  });

  test('reparents theme — replaces parentIds', async () => {
    await themeRepo.save(makeTheme({ id: 'p1', name: 'P1' }));
    await themeRepo.save(makeTheme({ id: 'p2', name: 'P2' }));
    await themeRepo.save(makeTheme({ id: 't1', name: 'T1', parentIds: ['p1'] }));
    await useCase.execute('t1', { parentIds: ['p2'] });
    const theme = await themeRepo.findById('t1');
    expect(theme?.parentIds).toEqual(['p2']);
  });

  test('throws on cycle: setting own descendant as parent', async () => {
    await themeRepo.save(makeTheme({ id: 'root', name: 'Root', parentIds: [] }));
    await themeRepo.save(makeTheme({ id: 'child', name: 'Child', parentIds: ['root'] }));
    await themeRepo.save(makeTheme({ id: 'grand', name: 'Grand', parentIds: ['child'] }));
    await expect(useCase.execute('root', { parentIds: ['grand'] })).rejects.toThrow('cycle');
  });

  test('throws if any parentId not found', async () => {
    await themeRepo.save(makeTheme({ id: 't1', name: 'T1' }));
    await expect(useCase.execute('t1', { parentIds: ['nonexistent'] })).rejects.toThrow(
      'Parent theme not found',
    );
  });
});

describe('MergeThemesUseCase', () => {
  let themeRepo: InMemoryThemeRepository;
  let noteRepo: InMemoryNoteRepository;
  let useCase: MergeThemesUseCase;

  beforeEach(() => {
    themeRepo = new InMemoryThemeRepository();
    noteRepo = new InMemoryNoteRepository();
    useCase = new MergeThemesUseCase(themeRepo, noteRepo);
  });

  test('throws if source not found', async () => {
    await themeRepo.save(makeTheme({ id: 'target', name: 'Target' }));
    await expect(useCase.execute('missing', 'target')).rejects.toThrow('Source theme not found');
  });

  test('throws if target not found', async () => {
    await themeRepo.save(makeTheme({ id: 'source', name: 'Source' }));
    await expect(useCase.execute('source', 'missing')).rejects.toThrow('Target theme not found');
  });

  test('throws if source and target are the same', async () => {
    await themeRepo.save(makeTheme({ id: 't1', name: 'T1' }));
    await expect(useCase.execute('t1', 't1')).rejects.toThrow('same');
  });

  test('moves notes from source to target bidirectionally', async () => {
    await themeRepo.save(makeTheme({ id: 'src', name: 'Src', noteIds: ['n1', 'n2'] }));
    await themeRepo.save(makeTheme({ id: 'tgt', name: 'Tgt', noteIds: [] }));
    await noteRepo.save(makeNote({ id: 'n1', themeIds: ['src'] }));
    await noteRepo.save(makeNote({ id: 'n2', themeIds: ['src'] }));

    await useCase.execute('src', 'tgt');

    const n1 = await noteRepo.findById('n1');
    const n2 = await noteRepo.findById('n2');
    expect(n1?.themeIds).toContain('tgt');
    expect(n1?.themeIds).not.toContain('src');
    expect(n2?.themeIds).toContain('tgt');
    expect(n2?.themeIds).not.toContain('src');

    const tgt = await themeRepo.findById('tgt');
    expect(tgt?.noteIds).toContain('n1');
    expect(tgt?.noteIds).toContain('n2');
  });

  test('does not duplicate notes already in target', async () => {
    await themeRepo.save(makeTheme({ id: 'src', name: 'Src', noteIds: ['n1'] }));
    await themeRepo.save(makeTheme({ id: 'tgt', name: 'Tgt', noteIds: ['n1'] }));
    await noteRepo.save(makeNote({ id: 'n1', themeIds: ['src', 'tgt'] }));

    await useCase.execute('src', 'tgt');

    const tgt = await themeRepo.findById('tgt');
    expect(tgt?.noteIds?.filter((id) => id === 'n1')).toHaveLength(1);
  });

  test('redirects children of source to target', async () => {
    await themeRepo.save(makeTheme({ id: 'src', name: 'Src', noteIds: [] }));
    await themeRepo.save(makeTheme({ id: 'tgt', name: 'Tgt', noteIds: [] }));
    await themeRepo.save(makeTheme({ id: 'child', name: 'Child', parentIds: ['src'] }));

    await useCase.execute('src', 'tgt');

    const child = await themeRepo.findById('child');
    expect(child?.parentIds).not.toContain('src');
    expect(child?.parentIds).toContain('tgt');
  });

  test('deletes source after merge', async () => {
    await themeRepo.save(makeTheme({ id: 'src', name: 'Src', noteIds: [] }));
    await themeRepo.save(makeTheme({ id: 'tgt', name: 'Tgt', noteIds: [] }));

    await useCase.execute('src', 'tgt');

    expect(await themeRepo.findById('src')).toBeNull();
  });

  test('returns merge summary', async () => {
    await themeRepo.save(makeTheme({ id: 'src', name: 'Src', noteIds: ['n1'] }));
    await themeRepo.save(makeTheme({ id: 'tgt', name: 'Tgt', noteIds: [] }));
    await noteRepo.save(makeNote({ id: 'n1', themeIds: ['src'] }));

    const result = await useCase.execute('src', 'tgt');

    expect(result.notesMoved).toBe(1);
    expect(result.deletedId).toBe('src');
  });
});
