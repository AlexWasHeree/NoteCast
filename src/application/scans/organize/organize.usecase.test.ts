import { describe, expect, test } from 'bun:test';
import type { IUserConfigRepository, UserConfig } from '../../../domain/config/config.types';
import { DEFAULT_USER_CONFIG } from '../../../domain/config/config.types';
import type { ILLMClient, LLMProvider } from '../../../domain/llm/llm.types';
import type { INoteRepository, Note } from '../../../domain/note/note.entity';
import type { IThemeRepository } from '../../../domain/theme/theme.entity';
import { OrganizeScanUseCase } from './organize.usecase';

// Simple unit vector helper: [1, 0] or [0, 1] variants for cosine similarity
function makeVec(a: number, b: number): number[] {
  const mag = Math.sqrt(a * a + b * b);
  return [a / mag, b / mag];
}

function makeScannedNote(id: string): Note {
  // Notes mostly aligned to dimension 0 (Software) with slight variation
  return {
    id,
    title: `Note ${id}`,
    content: 'content',
    status: 'scanned',
    themeIds: ['t1'],
    createdAt: new Date(),
    summary: 'summary',
    topics: ['topic'],
    contentVector: makeVec(0.9, 0.1),
    summaryVector: makeVec(0.9, 0.1),
    relatedNoteIds: [],
  };
}

function makeNoteRepo(scanned: Note[]): INoteRepository {
  return {
    findByStatus: async (s: Note['status']) => (s === 'scanned' ? scanned : []),
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

function makeThemeRepo(): IThemeRepository {
  return {
    findAll: async () => [
      {
        id: 't1',
        name: 'Software',
        noteIds: ['n1', 'n2', 'n3', 'n4', 'n5'],
        parentIds: [],
        createdAt: new Date(),
      },
      {
        id: 't2',
        name: 'Pessoal',
        noteIds: [],
        parentIds: [],
        createdAt: new Date(),
        // descriptionVector aligned to same direction as notes so cosine affinity is high
        // — ensures _analyzeMultiAssign finds candidates and calls the LLM
        descriptionVector: [1, 0],
      },
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
      return JSON.stringify({ multiAssignments: [] });
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

describe('OrganizeScanUseCase — clientRegistry + llmConfig resolution', () => {
  test('uses llmConfig.organize.provider from config, ignoring defaultProvider', async () => {
    let calledProvider = '';
    const registry = makeRegistry((p) => {
      calledProvider = p;
    });
    const configRepo = makeConfigRepo({ organize: { provider: 'anthropic' as LLMProvider } });

    const useCase = new OrganizeScanUseCase(
      makeNoteRepo([
        makeScannedNote('n1'),
        makeScannedNote('n2'),
        makeScannedNote('n3'),
        makeScannedNote('n4'),
        makeScannedNote('n5'),
      ]),
      makeThemeRepo(),
      registry,
      'codex' as LLMProvider,
      configRepo,
    );
    await useCase.generateProposal();

    expect(calledProvider).toBe('anthropic');
  });

  test('falls back to defaultProvider when llmConfig.organize is not set', async () => {
    let calledProvider = '';
    const registry = makeRegistry((p) => {
      calledProvider = p;
    });
    const configRepo = makeConfigRepo();

    const useCase = new OrganizeScanUseCase(
      makeNoteRepo([
        makeScannedNote('n1'),
        makeScannedNote('n2'),
        makeScannedNote('n3'),
        makeScannedNote('n4'),
        makeScannedNote('n5'),
      ]),
      makeThemeRepo(),
      registry,
      'openai' as LLMProvider,
      configRepo,
    );
    await useCase.generateProposal();

    expect(calledProvider).toBe('openai');
  });
});
