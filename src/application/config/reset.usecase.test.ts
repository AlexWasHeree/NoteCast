import { beforeEach, describe, expect, test } from 'bun:test';
import type { IUserConfigRepository, UserConfig } from '../../domain/config/config.types';
import { DEFAULT_USER_CONFIG } from '../../domain/config/config.types';
import type { Note } from '../../domain/note/note.entity';
import type { IScanProposalStore, ScanState } from '../../domain/scan/scan.state';
import type { Theme } from '../../domain/theme/theme.entity';
import {
  InMemoryNoteRepository,
  InMemoryThemeRepository,
  SimpleMemoryQueue,
} from '../../infrastructure/notes/adapters';
import { ResetUseCase } from './reset.usecase';

// Minimal IScanProposalStore stub
class StubProposalStore implements IScanProposalStore {
  committed: string[] = [];
  scanStateReset = false;
  commitCountersReset = false;

  async getPending(_type: string) {
    return null;
  }
  async savePending(_type: string, _proposal: unknown) {}
  async markCommitted(type: string) {
    this.committed.push(type);
  }
  async getScanState(): Promise<ScanState> {
    return { organizedCountAtLastConsolidate: 5, classifyCommitCount: 3, organizeCommitCount: 2 };
  }
  async updateScanState(patch: Partial<ScanState>) {
    if (patch.organizedCountAtLastConsolidate === 0) this.scanStateReset = true;
    if (patch.classifyCommitCount === 0 && patch.organizeCommitCount === 0)
      this.commitCountersReset = true;
  }
  async incrementCommitCount(_type: 'classify' | 'organize'): Promise<number> {
    return 0;
  }
}

class StubConfigRepo implements IUserConfigRepository {
  async get(): Promise<UserConfig> {
    return { ...DEFAULT_USER_CONFIG, baseThemes: [{ name: 'Base Theme' }] };
  }
  async save(_config: UserConfig) {}
}

function makeNote(id: string, status: Note['status']): Note {
  return {
    id,
    title: `Note ${id}`,
    content: 'content',
    status,
    themeIds: ['t1'],
    createdAt: new Date(),
    summary: 'sum',
    topics: ['t'],
    contentVector: [0.1],
    summaryVector: [],
    relatedNoteIds: [],
  };
}

function makeTheme(id: string): Theme {
  return { id, name: `Theme ${id}`, noteIds: ['n1'], createdAt: new Date(), parentIds: [] };
}

describe('ResetUseCase — soft reset', () => {
  let noteRepo: InMemoryNoteRepository;
  let themeRepo: InMemoryThemeRepository;
  let proposalStore: StubProposalStore;
  let configRepo: StubConfigRepo;
  let queue: SimpleMemoryQueue;
  let useCase: ResetUseCase;

  beforeEach(() => {
    noteRepo = new InMemoryNoteRepository();
    themeRepo = new InMemoryThemeRepository();
    proposalStore = new StubProposalStore();
    configRepo = new StubConfigRepo();
    queue = new SimpleMemoryQueue();
    useCase = new ResetUseCase(noteRepo, themeRepo, proposalStore, configRepo, queue);
  });

  test('deletes original themes before recreating base themes', async () => {
    await themeRepo.save(makeTheme('t1'));
    await useCase.execute(false);
    const themes = await themeRepo.findAll();
    expect(themes.find((t) => t.id === 't1')).toBeUndefined();
  });

  test('resets scanned notes to processed, clears themeIds', async () => {
    const note = makeNote('n1', 'scanned');
    await noteRepo.save(note);
    await useCase.execute(false);
    const updated = await noteRepo.findById('n1');
    expect(updated?.status).toBe('processed');
    expect(updated?.themeIds).toEqual([]);
  });

  test('resets organized notes to processed, clears themeIds', async () => {
    await noteRepo.save(makeNote('n1', 'organized'));
    await useCase.execute(false);
    const updated = await noteRepo.findById('n1');
    expect(updated?.status).toBe('processed');
  });

  test('leaves pending notes unchanged', async () => {
    await noteRepo.save(makeNote('n1', 'pending'));
    await useCase.execute(false);
    const updated = await noteRepo.findById('n1');
    expect(updated?.status).toBe('pending');
  });

  test('leaves processed notes with status processed (only clears themeIds)', async () => {
    await noteRepo.save(makeNote('n1', 'processed'));
    await useCase.execute(false);
    const updated = await noteRepo.findById('n1');
    expect(updated?.status).toBe('processed');
  });

  test('discards all pending proposals', async () => {
    await useCase.execute(false);
    expect(proposalStore.committed).toContain('classify');
    expect(proposalStore.committed).toContain('organize');
    expect(proposalStore.committed).toContain('consolidate');
  });

  test('recreates base themes from config after reset', async () => {
    await themeRepo.save(makeTheme('t1'));
    await useCase.execute(false);
    const themes = await themeRepo.findAll();
    expect(themes.some((t) => t.name === 'Base Theme')).toBe(true);
  });

  test('preserves summary/topics/vector on soft reset', async () => {
    await noteRepo.save(makeNote('n1', 'organized'));
    await useCase.execute(false);
    const updated = await noteRepo.findById('n1');
    expect(updated?.summary).toBe('sum');
    expect(updated?.topics).toEqual(['t']);
    expect(updated?.contentVector).toEqual([0.1]);
  });

  test('clears relatedNoteIds on soft reset', async () => {
    const note = makeNote('n1', 'organized');
    note.relatedNoteIds = ['other'];
    await noteRepo.save(note);
    await useCase.execute(false);
    const updated = await noteRepo.findById('n1');
    expect(updated?.relatedNoteIds).toEqual([]);
  });

  test('clears themeIds on processed notes during soft reset', async () => {
    const note = makeNote('n1', 'processed'); // makeNote sets themeIds: ['t1']
    await noteRepo.save(note);
    await useCase.execute(false);
    const updated = await noteRepo.findById('n1');
    expect(updated?.themeIds).toEqual([]);
  });

  test('resets commit counters on soft reset', async () => {
    await useCase.execute(false);
    expect(proposalStore.commitCountersReset).toBe(true);
    expect(proposalStore.scanStateReset).toBe(false);
  });
});

describe('ResetUseCase — descriptionVector on base theme recreation', () => {
  test('embeds description when embeddingClient is provided', async () => {
    const noteRepo = new InMemoryNoteRepository();
    const themeRepo = new InMemoryThemeRepository();
    const proposalStore = new StubProposalStore();
    const queue = new SimpleMemoryQueue();

    class ConfigWithDesc implements IUserConfigRepository {
      async get(): Promise<UserConfig> {
        return {
          ...DEFAULT_USER_CONFIG,
          baseThemes: [{ name: 'Tech', description: 'Technology notes' }],
        };
      }
      async save(_: UserConfig) {}
    }

    const stubEmbedding = { embed: async (_: string) => [0.1, 0.2, 0.3] };
    const useCase = new ResetUseCase(
      noteRepo,
      themeRepo,
      proposalStore,
      new ConfigWithDesc(),
      queue,
      stubEmbedding,
    );

    await useCase.execute(false);

    const themes = await themeRepo.findAll();
    const tech = themes.find((t) => t.name === 'Tech');
    expect(tech).toBeDefined();
    expect(tech?.description).toBe('Technology notes');
    expect(tech?.descriptionVector).toEqual([0.1, 0.2, 0.3]);
  });

  test('creates base theme without descriptionVector when no embeddingClient', async () => {
    const noteRepo = new InMemoryNoteRepository();
    const themeRepo = new InMemoryThemeRepository();
    const proposalStore = new StubProposalStore();
    const queue = new SimpleMemoryQueue();

    class ConfigWithDesc implements IUserConfigRepository {
      async get(): Promise<UserConfig> {
        return {
          ...DEFAULT_USER_CONFIG,
          baseThemes: [{ name: 'Tech', description: 'Technology notes' }],
        };
      }
      async save(_: UserConfig) {}
    }

    const useCase = new ResetUseCase(
      noteRepo,
      themeRepo,
      proposalStore,
      new ConfigWithDesc(),
      queue,
    );

    await useCase.execute(false);

    const themes = await themeRepo.findAll();
    const tech = themes.find((t) => t.name === 'Tech');
    expect(tech).toBeDefined();
    expect(tech?.description).toBe('Technology notes');
    expect(tech?.descriptionVector).toBeUndefined();
  });
});

describe('ResetUseCase — full reset', () => {
  let noteRepo: InMemoryNoteRepository;
  let themeRepo: InMemoryThemeRepository;
  let proposalStore: StubProposalStore;
  let configRepo: StubConfigRepo;
  let queue: SimpleMemoryQueue;
  let useCase: ResetUseCase;

  beforeEach(() => {
    noteRepo = new InMemoryNoteRepository();
    themeRepo = new InMemoryThemeRepository();
    proposalStore = new StubProposalStore();
    configRepo = new StubConfigRepo();
    queue = new SimpleMemoryQueue();
    useCase = new ResetUseCase(noteRepo, themeRepo, proposalStore, configRepo, queue);
  });

  test('regresses all notes to pending, clears AI fields', async () => {
    await noteRepo.save(makeNote('n1', 'organized'));
    await noteRepo.save(makeNote('n2', 'processed'));
    await noteRepo.save(makeNote('n3', 'pending'));
    await useCase.execute(true);

    for (const id of ['n1', 'n2', 'n3']) {
      const note = await noteRepo.findById(id);
      expect(note?.status).toBe('pending');
      expect(note?.summary).toBe('');
      expect(note?.topics).toEqual([]);
      expect(note?.contentVector).toEqual([]);
      expect(note?.summaryVector).toEqual([]);
    }
  });

  test('resets scan_state on full reset', async () => {
    await useCase.execute(true);
    expect(proposalStore.scanStateReset).toBe(true);
  });
});
