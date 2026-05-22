import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScanType } from '../domain/scan/scan.types';
import type { UnifiedProposal } from '../domain/scan/unified.proposal';

const createHeadlessMock = mock(async () => {
  throw new Error('createHeadless mock not configured');
});

mock.module('../bootstrap', () => ({
  createHeadless: createHeadlessMock,
}));

const { runCli } = await import('./index');

type PendingRecord = {
  type: ScanType;
  proposal: UnifiedProposal;
  status: 'pending' | 'committed';
  createdAt: Date;
};

class MemoryProposalStore {
  private records = new Map<ScanType, PendingRecord>();

  async savePending(type: ScanType, proposal: UnifiedProposal): Promise<void> {
    this.records.set(type, {
      type,
      proposal,
      status: 'pending',
      createdAt: new Date(),
    });
  }

  async getPending(type: ScanType): Promise<PendingRecord | null> {
    const record = this.records.get(type);
    return record?.status === 'pending' ? record : null;
  }

  async markCommitted(type: ScanType): Promise<void> {
    const record = this.records.get(type);
    if (!record) return;
    record.status = 'committed';
    this.records.set(type, record);
  }

  async getScanState() {
    return {
      organizedCountAtLastConsolidate: 0,
      classifyCommitCount: 0,
      organizeCommitCount: 0,
    };
  }

  async updateScanState(): Promise<void> {}

  async incrementCommitCount(): Promise<number> {
    return 0;
  }
}

function makeProposal(overrides: Partial<UnifiedProposal> = {}): UnifiedProposal {
  return {
    context: { themes: [], notes: [] },
    assignments: [],
    createThemes: [],
    splits: [],
    merges: [],
    redistributions: [],
    removals: [],
    addParents: [],
    removeParents: [],
    multiAssignments: [],
    ...overrides,
  };
}

function makeHeadless(overrides: Record<string, unknown> = {}) {
  return {
    scanProposalStore: new MemoryProposalStore(),
    classifyScanUseCase: {
      async execute() {
        return {
          scanType: 'classify' as const,
          notesProcessed: 0,
          notes: [],
          executedAt: new Date(),
        };
      },
      async commit() {
        return { themesCreated: 0, themesMerged: 0, notesUpdated: 0, notesFinalized: 0 };
      },
    },
    organizeScanUseCase: {
      async execute() {
        return {
          scanType: 'organize' as const,
          notesProcessed: 0,
          notes: [],
          executedAt: new Date(),
        };
      },
      async commit() {
        return { themesCreated: 0, themesMerged: 0, notesUpdated: 0, notesFinalized: 0 };
      },
    },
    consolidateScanUseCase: {
      async generateProposal() {
        return null;
      },
      async commit() {
        return {
          reroutingsApplied: 0,
          mergesApplied: 0,
          removalsApplied: 0,
          addParentsApplied: 0,
          removeParentsApplied: 0,
          multiAssignmentsApplied: 0,
          skipped: 0,
        };
      },
    },
    noteGraphUseCase: {
      async build() {},
    },
    noteRepository: {
      async findAll() {
        return [];
      },
    },
    themeRepository: {
      async findAll() {
        return [];
      },
    },
    vaultSyncer: {
      async saveProposal() {
        return null;
      },
      async sync() {},
    },
    scanOrchestrator: {
      async onClassifyCommit() {},
      async onOrganizeCommit() {},
      async onConsolidateCommit() {},
    },
    scanPipeline: {
      async waitForIdle() {},
      isRunning() {
        return false;
      },
    },
    userConfigRepository: {
      async get() {
        return {
          pipelineConfig: {
            classifyEvery: 10,
            organizeAfterClassifies: 2,
            consolidateAfterOrganizes: 3,
          },
          vaultPath: null,
        };
      },
    },
    ...overrides,
  };
}

describe('runCli scan proposals in direct mode', () => {
  const originalCwd = process.cwd();
  let tempDir = '';

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'notes-cli-test-'));
    process.chdir(tempDir);
    createHeadlessMock.mockImplementation(async () => {
      throw new Error('createHeadless mock not configured');
    });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('scan propose classify persists the generated unified proposal', async () => {
    const proposal = makeProposal({
      assignments: [{ noteId: 'n1', themeId: 't1' }],
      context: {
        themes: [{ id: 't1', name: 'Arquitetura' }],
        notes: [{ id: 'n1', title: 'Nota 1' }],
      },
    });
    const store = new MemoryProposalStore();

    createHeadlessMock.mockImplementation(
      async () =>
        makeHeadless({
          scanProposalStore: store,
          classifyScanUseCase: {
            async execute() {
              return {
                scanType: 'classify' as const,
                notesProcessed: 1,
                notes: [],
                executedAt: new Date(),
                unifiedProposal: proposal,
              };
            },
          },
          noteRepository: {
            async findAll() {
              return [{ id: 'n1', title: 'Nota 1' }];
            },
          },
          themeRepository: {
            async findAll() {
              return [{ id: 't1', name: 'Arquitetura' }];
            },
          },
        }) as never,
    );

    const exitCode = await runCli(['scan', 'propose', 'classify']);

    expect(exitCode).toBe(0);
    expect(await store.getPending('classify')).not.toBeNull();
    expect(existsSync(join(tempDir, 'proposal-classify.json'))).toBe(true);
  });

  test('scan commit consolidate accepts the proposal file produced by scan propose consolidate', async () => {
    const proposal = makeProposal({
      context: {
        themes: [{ id: 't1', name: 'Arquitetura' }],
        notes: [{ id: 'n1', title: 'Nota 1' }],
      },
      createThemes: [{ id: 't2', name: 'Fundamentos', parentIds: ['t1'] }],
      splits: [{ parentThemeId: 't1', newThemeId: 't2', noteIds: ['n1'] }],
    });
    const store = new MemoryProposalStore();
    await store.savePending('consolidate', proposal);

    createHeadlessMock.mockImplementation(
      async () =>
        makeHeadless({
          scanProposalStore: store,
          consolidateScanUseCase: {
            async commit(input: UnifiedProposal) {
              if (!Array.isArray((input as UnifiedProposal).createThemes)) {
                throw new Error('proposal.createThemes missing');
              }
              return {
                reroutingsApplied: 0,
                mergesApplied: 0,
                removalsApplied: 0,
                addParentsApplied: 0,
                removeParentsApplied: 0,
                multiAssignmentsApplied: 0,
                skipped: 0,
              };
            },
          },
          noteRepository: {
            async findAll() {
              return [{ id: 'n1', title: 'Nota 1' }];
            },
          },
          themeRepository: {
            async findAll() {
              return [{ id: 't1', name: 'Arquitetura' }];
            },
          },
        }) as never,
    );

    const proposeExitCode = await runCli(['scan', 'propose', 'consolidate']);
    expect(proposeExitCode).toBe(0);

    const savedProposal = JSON.parse(
      readFileSync(join(tempDir, 'proposal-consolidate.json'), 'utf-8'),
    ) as Partial<UnifiedProposal>;
    expect(Array.isArray(savedProposal.createThemes)).toBe(true);

    const commitExitCode = await runCli(['scan', 'commit', 'consolidate']);

    expect(commitExitCode).toBe(0);
    expect(await store.getPending('consolidate')).toBeNull();
    expect(existsSync(join(tempDir, 'proposal-consolidate.json'))).toBe(false);
  });
});
