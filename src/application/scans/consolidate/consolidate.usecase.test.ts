import { beforeEach, describe, expect, test } from 'bun:test';
import type { IUserConfigRepository } from '../../../domain/config/config.types';
import { DEFAULT_USER_CONFIG } from '../../../domain/config/config.types';
import type { ILLMClient, LLMProvider } from '../../../domain/llm/llm.types';
import type { Note } from '../../../domain/note/note.entity';
import type { UnifiedProposal } from '../../../domain/scan/unified.proposal';
import { emptyUnifiedProposal } from '../../../domain/scan/unified.proposal';
import type { Theme } from '../../../domain/theme/theme.entity';
import {
  InMemoryNoteRepository,
  InMemoryThemeRepository,
} from '../../../infrastructure/notes/adapters';
import {
  ConsolidateScanUseCase,
  computeCooccurrence,
  computeRerouteCandidates,
} from './consolidate.usecase';

function up(overrides: Partial<UnifiedProposal>): UnifiedProposal {
  return { ...emptyUnifiedProposal(), ...overrides };
}

// Helper: create a minimal Note
function makeNote(
  id: string,
  themeIds: string[],
  relatedNoteIds: string[] = [],
  vector: number[] = [],
): Note {
  return {
    id,
    title: `Note ${id}`,
    content: '',
    status: 'organized',
    themeIds,
    createdAt: new Date(),
    summary: '',
    topics: [],
    contentVector: vector,
    summaryVector: [],
    relatedNoteIds,
  };
}

// Helper: create a minimal Theme
function makeTheme(id: string, noteIds: string[], parentIds: string[] = []): Theme {
  return { id, name: `Theme ${id}`, noteIds, createdAt: new Date(), parentIds };
}

// --- computeRerouteCandidates ---

describe('computeRerouteCandidates', () => {
  test('returns candidate when >50% of relatedNoteIds are in a different theme', () => {
    // n1 is in themeA; its 4 related notes: 3 in themeB, 1 in themeA
    const n1 = makeNote('n1', ['themeA'], ['n2', 'n3', 'n4', 'n5']);
    const n2 = makeNote('n2', ['themeB']);
    const n3 = makeNote('n3', ['themeB']);
    const n4 = makeNote('n4', ['themeB']);
    const n5 = makeNote('n5', ['themeA']);
    const noteMap = new Map([
      ['n2', n2],
      ['n3', n3],
      ['n4', n4],
      ['n5', n5],
    ]);
    const themes = [makeTheme('themeA', ['n1', 'n5']), makeTheme('themeB', ['n2', 'n3', 'n4'])];

    const candidates = computeRerouteCandidates([n1], noteMap, themes);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.noteId).toBe('n1');
    expect(candidates[0]?.fromThemeId).toBe('themeA');
    expect(candidates[0]?.toThemeId).toBe('themeB');
    expect(candidates[0]?.linkRatio).toBeCloseTo(0.75);
  });

  test('skips notes with empty or undefined themeIds', () => {
    const n1 = makeNote('n1', [], ['n2']);
    const n2 = makeNote('n2', ['themeA']);
    const noteMap = new Map([['n2', n2]]);
    const themes = [makeTheme('themeA', ['n2'])];

    expect(computeRerouteCandidates([n1], noteMap, themes)).toHaveLength(0);
  });

  test('skips note when top linked theme is already in its themeIds', () => {
    // n1 already in themeB; most links also in themeB — not a candidate
    const n1 = makeNote('n1', ['themeA', 'themeB'], ['n2', 'n3', 'n4']);
    const n2 = makeNote('n2', ['themeB']);
    const n3 = makeNote('n3', ['themeB']);
    const n4 = makeNote('n4', ['themeB']);
    const noteMap = new Map([
      ['n2', n2],
      ['n3', n3],
      ['n4', n4],
    ]);
    const themes = [makeTheme('themeA', ['n1']), makeTheme('themeB', ['n1', 'n2', 'n3', 'n4'])];

    expect(computeRerouteCandidates([n1], noteMap, themes)).toHaveLength(0);
  });

  test('skips note when cross-theme link ratio is below 0.5', () => {
    // n1 in themeA; 2 out of 5 related in themeB (ratio 0.4)
    const n1 = makeNote('n1', ['themeA'], ['n2', 'n3', 'n4', 'n5', 'n6']);
    const n2 = makeNote('n2', ['themeB']);
    const n3 = makeNote('n3', ['themeB']);
    const n4 = makeNote('n4', ['themeA']);
    const n5 = makeNote('n5', ['themeA']);
    const n6 = makeNote('n6', ['themeA']);
    const noteMap = new Map([
      ['n2', n2],
      ['n3', n3],
      ['n4', n4],
      ['n5', n5],
      ['n6', n6],
    ]);
    const themes = [makeTheme('themeA', ['n1']), makeTheme('themeB', ['n2', 'n3'])];

    expect(computeRerouteCandidates([n1], noteMap, themes)).toHaveLength(0);
  });

  test('for multi-theme note, fromThemeId is the theme least represented in links', () => {
    // n1 in [themeA, themeB]; links: 3 in themeC, 0 in themeA, 1 in themeB
    // fromThemeId should be themeA (least represented)
    const n1 = makeNote('n1', ['themeA', 'themeB'], ['n2', 'n3', 'n4', 'n5']);
    const n2 = makeNote('n2', ['themeC']);
    const n3 = makeNote('n3', ['themeC']);
    const n4 = makeNote('n4', ['themeC']);
    const n5 = makeNote('n5', ['themeB']);
    const noteMap = new Map([
      ['n2', n2],
      ['n3', n3],
      ['n4', n4],
      ['n5', n5],
    ]);
    const themes = [
      makeTheme('themeA', ['n1']),
      makeTheme('themeB', ['n1', 'n5']),
      makeTheme('themeC', ['n2', 'n3', 'n4']),
    ];

    const candidates = computeRerouteCandidates([n1], noteMap, themes);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.fromThemeId).toBe('themeA');
    expect(candidates[0]?.toThemeId).toBe('themeC');
  });
});

// --- computeCooccurrence ---

describe('computeCooccurrence', () => {
  test('detects high co-occurrence for addParent candidate', () => {
    // Theme B has 4 notes, 3 of which also belong to theme A
    const n1 = makeNote('n1', ['tA', 'tB']);
    const n2 = makeNote('n2', ['tA', 'tB']);
    const n3 = makeNote('n3', ['tA', 'tB']);
    const n4 = makeNote('n4', ['tB']);
    const noteMap = new Map([
      ['n1', n1],
      ['n2', n2],
      ['n3', n3],
      ['n4', n4],
    ]);
    const tA = makeTheme('tA', ['n1', 'n2', 'n3']);
    const tB = makeTheme('tB', ['n1', 'n2', 'n3', 'n4']);
    const themes = [tA, tB];

    const result = computeCooccurrence(tB, noteMap, themes);
    expect(result.get('tA')).toBeCloseTo(0.75);
  });

  test('returns 0 for themes with no overlap', () => {
    const n1 = makeNote('n1', ['tA']);
    const n2 = makeNote('n2', ['tB']);
    const noteMap = new Map([
      ['n1', n1],
      ['n2', n2],
    ]);
    const tA = makeTheme('tA', ['n1']);
    const tB = makeTheme('tB', ['n2']);

    const result = computeCooccurrence(tA, noteMap, [tA, tB]);
    expect(result.get('tB')).toBe(0);
  });

  test('excludes self from co-occurrence', () => {
    const n1 = makeNote('n1', ['tA']);
    const noteMap = new Map([['n1', n1]]);
    const tA = makeTheme('tA', ['n1']);

    const result = computeCooccurrence(tA, noteMap, [tA]);
    expect(result.has('tA')).toBe(false);
  });
});

// --- ConsolidateScanUseCase.commit ---

describe('ConsolidateScanUseCase.commit', () => {
  let noteRepo: InMemoryNoteRepository;
  let themeRepo: InMemoryThemeRepository;
  let useCase: ConsolidateScanUseCase;

  beforeEach(() => {
    noteRepo = new InMemoryNoteRepository();
    themeRepo = new InMemoryThemeRepository();
    useCase = new ConsolidateScanUseCase(noteRepo, themeRepo);
  });

  test('applies rerouting: moves note from fromTheme to toTheme', async () => {
    const note = makeNote('n1', ['tA']);
    const tA = makeTheme('tA', ['n1']);
    const tB = makeTheme('tB', []);
    await noteRepo.save(note);
    await themeRepo.save(tA);
    await themeRepo.save(tB);

    const result = await useCase.commit(
      up({
        merges: [],
        redistributions: [{ noteId: 'n1', fromThemeId: 'tA', toThemeId: 'tB' }],
        removals: [],
      }),
    );

    expect(result.reroutingsApplied).toBe(1);
    expect(result.skipped).toBe(0);

    const updatedNote = await noteRepo.findById('n1');
    expect(updatedNote?.themeIds).not.toContain('tA');
    expect(updatedNote?.themeIds).toContain('tB');

    const updatedTA = await themeRepo.findById('tA');
    expect(updatedTA?.noteIds).not.toContain('n1');

    const updatedTB = await themeRepo.findById('tB');
    expect(updatedTB?.noteIds).toContain('n1');
  });

  test('applies merge: migrates noteIds from source to target, deletes source', async () => {
    const n1 = makeNote('n1', ['tA']);
    const n2 = makeNote('n2', ['tB']);
    const tA = makeTheme('tA', ['n1']);
    const tB = makeTheme('tB', ['n2']); // tB is leaf (no children)
    await noteRepo.save(n1);
    await noteRepo.save(n2);
    await themeRepo.save(tA);
    await themeRepo.save(tB);

    const result = await useCase.commit(
      up({
        merges: [{ sourceThemeId: 'tA', targetThemeId: 'tB' }],
        redistributions: [],
        removals: [],
      }),
    );

    expect(result.mergesApplied).toBe(1);
    expect(result.skipped).toBe(0);

    // source deleted
    expect(await themeRepo.findById('tA')).toBeNull();

    // target has both notes
    const updatedTB = await themeRepo.findById('tB');
    expect(updatedTB?.noteIds).toContain('n1');
    expect(updatedTB?.noteIds).toContain('n2');

    // n1.themeIds updated
    const updatedN1 = await noteRepo.findById('n1');
    expect(updatedN1?.themeIds).toContain('tB');
    expect(updatedN1?.themeIds).not.toContain('tA');
  });

  test('applies removal: deletes empty theme', async () => {
    const emptyTheme = makeTheme('tEmpty', []);
    await themeRepo.save(emptyTheme);

    const result = await useCase.commit(
      up({
        merges: [],
        redistributions: [],
        removals: ['tEmpty'],
      }),
    );

    expect(result.removalsApplied).toBe(1);
    expect(result.skipped).toBe(0);
    expect(await themeRepo.findById('tEmpty')).toBeNull();
  });

  test('skips removal if theme is not empty at commit time', async () => {
    const theme = makeTheme('tFull', ['n1']); // not empty
    await themeRepo.save(theme);

    const result = await useCase.commit(
      up({
        merges: [],
        redistributions: [],
        removals: ['tFull'],
      }),
    );

    expect(result.removalsApplied).toBe(0);
    expect(result.skipped).toBe(1);
    expect(await themeRepo.findById('tFull')).not.toBeNull();
  });

  test('skips merge when source does not exist', async () => {
    const tB = makeTheme('tB', []);
    await themeRepo.save(tB);

    const result = await useCase.commit(
      up({
        merges: [{ sourceThemeId: 'nonexistent', targetThemeId: 'tB' }],
        redistributions: [],
        removals: [],
      }),
    );

    expect(result.mergesApplied).toBe(0);
    expect(result.skipped).toBe(1);
  });

  test('skips rerouting when note does not belong to fromTheme', async () => {
    const note = makeNote('n1', ['tC']); // note is in tC, not tA
    const tA = makeTheme('tA', []);
    const tB = makeTheme('tB', []);
    await noteRepo.save(note);
    await themeRepo.save(tA);
    await themeRepo.save(tB);

    const result = await useCase.commit(
      up({
        merges: [],
        redistributions: [{ noteId: 'n1', fromThemeId: 'tA', toThemeId: 'tB' }],
        removals: [],
      }),
    );

    expect(result.reroutingsApplied).toBe(0);
    expect(result.skipped).toBe(1);
  });

  test('skips rerouting when fromThemeId === toThemeId', async () => {
    const note = makeNote('n1', ['tA']);
    const tA = makeTheme('tA', ['n1']);
    await noteRepo.save(note);
    await themeRepo.save(tA);

    const result = await useCase.commit(
      up({
        merges: [],
        redistributions: [{ noteId: 'n1', fromThemeId: 'tA', toThemeId: 'tA' }],
        removals: [],
      }),
    );

    expect(result.reroutingsApplied).toBe(0);
    expect(result.skipped).toBe(1);
  });

  test('preserves bidirectional consistency after rerouting', async () => {
    const note = makeNote('n1', ['tA']);
    const tA = makeTheme('tA', ['n1']);
    const tB = makeTheme('tB', ['n2']);
    await noteRepo.save(note);
    await noteRepo.save(makeNote('n2', ['tB']));
    await themeRepo.save(tA);
    await themeRepo.save(tB);

    await useCase.commit(
      up({
        merges: [],
        redistributions: [{ noteId: 'n1', fromThemeId: 'tA', toThemeId: 'tB' }],
        removals: [],
      }),
    );

    const updatedNote = await noteRepo.findById('n1');
    const updatedTA = await themeRepo.findById('tA');
    const updatedTB = await themeRepo.findById('tB');

    // note.themeIds ↔ theme.noteIds consistent
    expect(updatedNote?.themeIds).toContain('tB');
    expect(updatedNote?.themeIds).not.toContain('tA');
    expect(updatedTA?.noteIds).not.toContain('n1');
    expect(updatedTB?.noteIds).toContain('n1');
  });
});

describe('ConsolidateScanUseCase — constructor accepts clientRegistry', () => {
  test('instantiates with clientRegistry and defaultProvider without error', async () => {
    const registry: Record<LLMProvider, ILLMClient> = {
      ollama: { chat: async () => '{"approved":[],"rejected":[]}' },
      codex: { chat: async () => '{"approved":[],"rejected":[]}' },
      openai: { chat: async () => '{"approved":[],"rejected":[]}' },
      anthropic: { chat: async () => '{"approved":[],"rejected":[]}' },
      gemini: { chat: async () => '{"approved":[],"rejected":[]}' },
      deepseek: { chat: async () => '{"approved":[],"rejected":[]}' },
    };
    const configRepo: IUserConfigRepository = {
      get: async () => ({
        ...DEFAULT_USER_CONFIG,
        llmConfig: { consolidate: { provider: 'gemini' as LLMProvider } },
      }),
      save: async () => {},
    };
    const useCase = new ConsolidateScanUseCase(
      new InMemoryNoteRepository(),
      new InMemoryThemeRepository(),
      registry,
      'codex' as LLMProvider,
      configRepo,
    );
    const result = await useCase.generateProposal();
    expect(result).not.toBeNull();
    expect(result?.splits).toEqual([]);
    expect(result?.redistributions).toEqual([]);
  });
});
