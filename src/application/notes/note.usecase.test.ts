import { beforeEach, describe, expect, test } from 'bun:test';
import type { Note } from '../../domain/note/note.entity';
import type { Theme } from '../../domain/theme/theme.entity';
import {
  InMemoryNoteRepository,
  InMemoryThemeRepository,
} from '../../infrastructure/notes/adapters';
import { DeleteNoteUseCase, EditNoteUseCase } from './note.usecase';

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: 'n1',
    title: 'Test Note',
    content: 'Some content',
    status: 'organized',
    themeIds: [],
    createdAt: new Date(),
    summary: 'summary',
    topics: ['topic'],
    contentVector: [0.1, 0.2],
    summaryVector: [],
    relatedNoteIds: [],
    ...overrides,
  };
}

function makeTheme(overrides: Partial<Theme> = {}): Theme {
  return {
    id: 't1',
    name: 'Theme 1',
    noteIds: [],
    createdAt: new Date(),
    parentIds: [],
    ...overrides,
  };
}

// --- DeleteNoteUseCase ---

describe('DeleteNoteUseCase', () => {
  let noteRepo: InMemoryNoteRepository;
  let themeRepo: InMemoryThemeRepository;
  let useCase: DeleteNoteUseCase;

  beforeEach(() => {
    noteRepo = new InMemoryNoteRepository();
    themeRepo = new InMemoryThemeRepository();
    useCase = new DeleteNoteUseCase(noteRepo, themeRepo);
  });

  test('returns false when note does not exist', async () => {
    const result = await useCase.execute('nonexistent');
    expect(result).toBe(false);
  });

  test('deletes note from repository', async () => {
    const note = makeNote();
    await noteRepo.save(note);
    await useCase.execute('n1');
    expect(await noteRepo.findById('n1')).toBeNull();
  });

  test('removes noteId from theme.noteIds bidirectionally', async () => {
    const theme = makeTheme({ noteIds: ['n1'] });
    const note = makeNote({ themeIds: ['t1'] });
    await themeRepo.save(theme);
    await noteRepo.save(note);

    await useCase.execute('n1');

    const updatedTheme = await themeRepo.findById('t1');
    expect(updatedTheme?.noteIds).not.toContain('n1');
  });

  test('theme is not deleted even if it becomes empty', async () => {
    const theme = makeTheme({ noteIds: ['n1'] });
    const note = makeNote({ themeIds: ['t1'] });
    await themeRepo.save(theme);
    await noteRepo.save(note);

    await useCase.execute('n1');

    expect(await themeRepo.findById('t1')).not.toBeNull();
  });

  test('returns true on successful delete', async () => {
    await noteRepo.save(makeNote());
    const result = await useCase.execute('n1');
    expect(result).toBe(true);
  });
});

// --- EditNoteUseCase ---

class NoopQueue {
  enqueued: string[] = [];
  async enqueue(id: string) {
    this.enqueued.push(id);
  }
}

describe('EditNoteUseCase', () => {
  let noteRepo: InMemoryNoteRepository;
  let themeRepo: InMemoryThemeRepository;
  let queue: NoopQueue;
  let useCase: EditNoteUseCase;

  beforeEach(() => {
    noteRepo = new InMemoryNoteRepository();
    themeRepo = new InMemoryThemeRepository();
    queue = new NoopQueue();
    useCase = new EditNoteUseCase(noteRepo, themeRepo, queue);
  });

  test('returns null when note does not exist', async () => {
    const result = await useCase.execute('nonexistent', { title: 'New' });
    expect(result).toBeNull();
  });

  test('updates title on pending note without regression', async () => {
    await noteRepo.save(makeNote({ status: 'pending', themeIds: [] }));
    const result = await useCase.execute('n1', { title: 'Updated' });
    expect(result?.title).toBe('Updated');
    expect(result?.status).toBe('pending');
    expect(queue.enqueued).toHaveLength(0);
  });

  test('updates title on processed note without regression', async () => {
    await noteRepo.save(makeNote({ status: 'processed', themeIds: [] }));
    const result = await useCase.execute('n1', { title: 'Updated' });
    expect(result?.status).toBe('processed');
    expect(queue.enqueued).toHaveLength(0);
  });

  test('regresses scanned note to pending when content changes', async () => {
    const theme = makeTheme({ noteIds: ['n1'] });
    await themeRepo.save(theme);
    await noteRepo.save(makeNote({ status: 'scanned', themeIds: ['t1'] }));

    const result = await useCase.execute('n1', { content: 'New content' });

    expect(result?.status).toBe('pending');
    expect(result?.summary).toBe('');
    expect(result?.topics).toEqual([]);
    expect(result?.contentVector).toEqual([]);
    expect(result?.summaryVector).toEqual([]);
    expect(result?.themeIds).toEqual([]);
  });

  test('regresses organized note to pending when title changes', async () => {
    await noteRepo.save(makeNote({ status: 'organized', themeIds: [] }));
    const result = await useCase.execute('n1', { title: 'New Title' });
    expect(result?.status).toBe('pending');
  });

  test('re-enqueues note for Stage 1 when regressed', async () => {
    await noteRepo.save(makeNote({ status: 'organized', themeIds: [] }));
    await useCase.execute('n1', { title: 'Changed' });
    expect(queue.enqueued).toContain('n1');
  });

  test('removes note from theme.noteIds when regressed', async () => {
    const theme = makeTheme({ noteIds: ['n1'] });
    await themeRepo.save(theme);
    await noteRepo.save(makeNote({ status: 'scanned', themeIds: ['t1'] }));

    await useCase.execute('n1', { title: 'Changed' });

    const updatedTheme = await themeRepo.findById('t1');
    expect(updatedTheme?.noteIds).not.toContain('n1');
  });

  test('clears relatedNoteIds when regressed', async () => {
    await noteRepo.save(
      makeNote({ status: 'organized', relatedNoteIds: ['other-1'], themeIds: [] }),
    );
    const result = await useCase.execute('n1', { title: 'Changed' });
    expect(result?.relatedNoteIds).toEqual([]);
  });

  test('no regression when same title/content passed to scanned note', async () => {
    await noteRepo.save(
      makeNote({ status: 'scanned', title: 'Same', content: 'Same content', themeIds: [] }),
    );
    const result = await useCase.execute('n1', { title: 'Same', content: 'Same content' });
    expect(result?.status).toBe('scanned');
  });
});

describe('EditNoteUseCase — stale theme reference', () => {
  test('does not throw when themeId points to non-existent theme', async () => {
    const noteRepo2 = new InMemoryNoteRepository();
    const themeRepo2 = new InMemoryThemeRepository();
    const queue2 = new NoopQueue();
    const useCase2 = new EditNoteUseCase(noteRepo2, themeRepo2, queue2);
    // Note has a themeId but the theme does not exist in the repo
    await noteRepo2.save(makeNote({ status: 'scanned', themeIds: ['ghost-id'] }));
    const result = await useCase2.execute('n1', { content: 'New content' });
    expect(result).not.toBeNull();
    expect(result?.status).toBe('pending');
  });
});
