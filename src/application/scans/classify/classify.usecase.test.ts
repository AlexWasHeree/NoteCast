import { describe, expect, test } from 'bun:test';
import type { IUserConfigRepository, UserConfig } from '../../../domain/config/config.types';
import { DEFAULT_USER_CONFIG } from '../../../domain/config/config.types';
import type { ChatOptions, ILLMClient, LLMProvider } from '../../../domain/llm/llm.types';
import type { INoteRepository, Note } from '../../../domain/note/note.entity';
import type { IThemeRepository, Theme } from '../../../domain/theme/theme.entity';
import { buildClassifyHints, ClassifyScanUseCase } from './classify.usecase';

function makeNote(
  id: string,
  vector: number[],
  status: Note['status'] = 'scanned',
  themeIds: string[] = [],
): Note {
  return {
    id,
    title: `Note ${id}`,
    content: '',
    status,
    themeIds,
    createdAt: new Date(),
    summary: `summary of ${id}`,
    topics: [],
    contentVector: vector,
    summaryVector: [],
    relatedNoteIds: [],
  };
}

function makeTheme(id: string, name: string): Theme {
  return { id, name, noteIds: [], createdAt: new Date(), parentIds: [] };
}

describe('buildClassifyHints', () => {
  test('returns hint string for a note with similar classified notes', () => {
    const newNote = makeNote('new1', [1, 0, 0], 'processed');
    const classified = makeNote('cls1', [0.99, 0.01, 0], 'scanned', ['theme1']);
    const themeMap = new Map([['theme1', makeTheme('theme1', 'Software')]]);

    const hints = buildClassifyHints([newNote], [classified], themeMap, 0.75, 3);

    expect(hints.get('new1')).toContain('Note cls1');
    expect(hints.get('new1')).toContain('Software');
  });

  test('returns empty string for note with no similar classified notes', () => {
    const newNote = makeNote('new1', [1, 0, 0], 'processed');
    const unrelated = makeNote('cls1', [0, 0, 1], 'scanned', ['theme1']);
    const themeMap = new Map([['theme1', makeTheme('theme1', 'Software')]]);

    const hints = buildClassifyHints([newNote], [unrelated], themeMap, 0.75, 3);

    expect(hints.get('new1')).toBe('');
  });

  test('skips classified notes with no themeIds', () => {
    const newNote = makeNote('new1', [1, 0, 0], 'processed');
    const noTheme = makeNote('cls1', [0.99, 0, 0], 'scanned', []);
    const themeMap = new Map<string, Theme>();

    const hints = buildClassifyHints([newNote], [noTheme], themeMap, 0.75, 3);

    expect(hints.get('new1')).toBe('');
  });

  test('respects k limit — shows at most k similar notes', () => {
    const newNote = makeNote('new1', [1, 0, 0], 'processed');
    const classified = [
      makeNote('c1', [0.99, 0, 0], 'scanned', ['t1']),
      makeNote('c2', [0.98, 0, 0], 'scanned', ['t1']),
      makeNote('c3', [0.97, 0, 0], 'scanned', ['t1']),
      makeNote('c4', [0.96, 0, 0], 'scanned', ['t1']),
    ];
    const themeMap = new Map([['t1', makeTheme('t1', 'Software')]]);

    const hints = buildClassifyHints([newNote], classified, themeMap, 0.75, 2);
    const hint = hints.get('new1') ?? '';
    const count = (hint.match(/→ theme:/g) ?? []).length;
    expect(count).toBeLessThanOrEqual(2);
  });

  test('returns empty map when no new notes', () => {
    const hints = buildClassifyHints([], [], new Map(), 0.75, 3);
    expect(hints.size).toBe(0);
  });
});

describe('ClassifyScanUseCase.execute — single-fetch consistency', () => {
  function makeProcessedNote(id: string): Note {
    return {
      id,
      title: `Note ${id}`,
      content: '',
      status: 'processed',
      themeIds: [],
      createdAt: new Date(),
      summary: '',
      topics: [],
      contentVector: [],
      summaryVector: [],
      relatedNoteIds: [],
    };
  }

  function makeNoteRepo(processedNotes: Note[]): {
    repo: INoteRepository;
    processedFetchCount: () => number;
  } {
    let count = 0;
    const repo = {
      findByStatus: async (status: Note['status']) => {
        if (status === 'processed') {
          count++;
          return processedNotes;
        }
        return [];
      },
      findById: async () => null,
      save: async () => {},
      update: async () => {},
      delete: async () => {},
      findAll: async () => [],
      findByIds: async () => [],
      knnByContentVector: async () => [],
      knnBySummaryVector: async () => [],
    } as unknown as INoteRepository;
    return { repo, processedFetchCount: () => count };
  }

  function makeThemeRepo(): IThemeRepository {
    return {
      findAll: async () => [],
      findById: async () => null,
      save: async () => {},
      update: async () => {},
      delete: async () => {},
    } as unknown as IThemeRepository;
  }

  test('fetches processed notes exactly once — generateProposal does not re-fetch', async () => {
    const notes = [makeProcessedNote('n1'), makeProcessedNote('n2')];
    const { repo, processedFetchCount } = makeNoteRepo(notes);

    const useCase = new ClassifyScanUseCase(repo, makeThemeRepo());
    await useCase.execute();

    expect(processedFetchCount()).toBe(1);
  });

  test('result.notes matches the single-fetch snapshot', async () => {
    const notes = [makeProcessedNote('n1'), makeProcessedNote('n2')];
    const { repo } = makeNoteRepo(notes);

    const useCase = new ClassifyScanUseCase(repo, makeThemeRepo());
    const result = await useCase.execute();

    expect(result.notes.map((n) => n.id)).toEqual(['n1', 'n2']);
    expect(result.notesProcessed).toBe(2);
  });
});

describe('ClassifyScanUseCase — clientRegistry + llmConfig resolution', () => {
  function makeNote2(id: string): Note {
    return {
      id,
      title: `Note ${id}`,
      content: 'some content',
      status: 'processed',
      themeIds: [],
      createdAt: new Date(),
      summary: 'summary',
      topics: ['topic1'],
      contentVector: [],
      summaryVector: [],
      relatedNoteIds: [],
    };
  }

  function makeNoteRepo2(notes: Note[]): INoteRepository {
    return {
      findByStatus: async (s: Note['status']) => (s === 'processed' ? notes : []),
      findById: async () => null,
      save: async () => {},
      update: async () => {},
      delete: async () => {},
      findAll: async () => [],
      findByIds: async () => [],
      knnByContentVector: async () => [],
      knnBySummaryVector: async () => [],
    } as unknown as INoteRepository;
  }

  function makeThemeRepo2(): IThemeRepository {
    return {
      findAll: async () => [
        { id: 't1', name: 'Software', noteIds: [], parentIds: [], createdAt: new Date() },
      ],
      findById: async () => null,
      save: async () => {},
      update: async () => {},
      delete: async () => {},
    } as unknown as IThemeRepository;
  }

  function makeRegistry(onCall: (provider: string) => void): Record<LLMProvider, ILLMClient> {
    const stub = (name: string): ILLMClient => ({
      chat: async () => {
        onCall(name);
        return JSON.stringify({ assignments: [{ noteId: 'n1', themeNames: ['Software'] }] });
      },
    });
    return {
      ollama: stub('ollama'),
      codex: stub('codex'),
      openai: stub('openai'),
      anthropic: stub('anthropic'),
      gemini: stub('gemini'),
      deepseek: stub('deepseek'),
    };
  }

  function makeConfigRepo(llmConfig?: UserConfig['llmConfig']): IUserConfigRepository {
    return {
      get: async () => ({ ...DEFAULT_USER_CONFIG, ...(llmConfig ? { llmConfig } : {}) }),
      save: async () => {},
    } as IUserConfigRepository;
  }

  test('uses llmConfig.classify.provider from config, ignoring defaultProvider', async () => {
    let calledProvider = '';
    const registry = makeRegistry((p) => {
      calledProvider = p;
    });
    const configRepo = makeConfigRepo({ classify: { provider: 'openai' as LLMProvider } });

    const useCase = new ClassifyScanUseCase(
      makeNoteRepo2([makeNote2('n1')]),
      makeThemeRepo2(),
      registry,
      'codex' as LLMProvider,
      configRepo,
    );
    await useCase.generateProposal([makeNote2('n1')]);

    expect(calledProvider).toBe('openai');
  });

  test('falls back to defaultProvider when llmConfig.classify is not set', async () => {
    let calledProvider = '';
    const registry = makeRegistry((p) => {
      calledProvider = p;
    });
    const configRepo = makeConfigRepo(); // no llmConfig

    const useCase = new ClassifyScanUseCase(
      makeNoteRepo2([makeNote2('n1')]),
      makeThemeRepo2(),
      registry,
      'codex' as LLMProvider,
      configRepo,
    );
    await useCase.generateProposal([makeNote2('n1')]);

    expect(calledProvider).toBe('codex');
  });

  test('injects model override from llmConfig.classify.model into chat options', async () => {
    let capturedModel: string | undefined;
    const registry: Record<LLMProvider, ILLMClient> = {
      ollama: null as unknown as ILLMClient,
      codex: null as unknown as ILLMClient,
      openai: {
        chat: async (_q: string, opts?: ChatOptions) => {
          capturedModel = opts?.model;
          return JSON.stringify({ assignments: [{ noteId: 'n1', themeNames: ['Software'] }] });
        },
      },
      anthropic: null as unknown as ILLMClient,
      gemini: null as unknown as ILLMClient,
      deepseek: null as unknown as ILLMClient,
    };
    const configRepo = makeConfigRepo({
      classify: { provider: 'openai' as LLMProvider, model: 'gpt-5.4' },
    });

    const useCase = new ClassifyScanUseCase(
      makeNoteRepo2([makeNote2('n1')]),
      makeThemeRepo2(),
      registry,
      'codex' as LLMProvider,
      configRepo,
    );
    await useCase.generateProposal([makeNote2('n1')]);

    expect(capturedModel).toBe('gpt-5.4');
  });
});
