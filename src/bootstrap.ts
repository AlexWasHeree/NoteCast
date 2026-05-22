import { GetConfigUseCase, UpdateConfigUseCase } from './application/config/config.usecase';
import { ResetUseCase } from './application/config/reset.usecase';
import { NoteGraphUseCase } from './application/graph/graph.usecase';
import {
  CreateNotesBatchUseCase,
  CreateNoteUseCase,
  DeleteNoteUseCase,
  EditNoteUseCase,
  GetNoteUseCase,
  type IQueueProvider,
  ListNotesUseCase,
  RetryFailedNotesUseCase,
} from './application/notes/note.usecase';
import { ClassifyScanUseCase } from './application/scans/classify/classify.usecase';
import { ConsolidateScanUseCase } from './application/scans/consolidate/consolidate.usecase';
import { OrganizeScanUseCase } from './application/scans/organize/organize.usecase';
import { ScanOrchestrator } from './application/scans/pipeline/scan.orchestrator';
import { ScanPipeline } from './application/scans/pipeline/scan.pipeline';
import {
  AssignNoteToThemeUseCase,
  CreateThemeUseCase,
  DeleteThemeUseCase,
  ListThemesUseCase,
  MergeThemesUseCase,
  RemoveNoteFromThemeUseCase,
  UpdateThemeUseCase,
} from './application/themes/theme.usecase';
import type { IEmbeddingClient, ILLMClient } from './domain/llm/llm.types';
import type { IVectorStore } from './domain/vector/vector.store';
import { LanceDBVectorStore } from './infrastructure/lancedb/lancedb.vector.store';
import {
  type ApiProviderName,
  createClientRegistry,
  createEmbeddingRegistry,
  detectAvailableProviders,
} from './infrastructure/llm/clients/llm.factory';
import { OllamaClient, OllamaEmbeddingClient } from './infrastructure/llm/clients/ollama.client';
import { logger } from './infrastructure/logger';
import { SimpleMemoryQueue } from './infrastructure/notes/adapters';
import { NoteProcessor } from './infrastructure/notes/note.worker';
import { createDatabase } from './infrastructure/sqlite/database';
import { SQLiteUserConfigRepository } from './infrastructure/sqlite/sqlite.config.repository';
import {
  SQLiteNoteRepository,
  SQLiteThemeRepository,
} from './infrastructure/sqlite/sqlite.repositories';
import { SQLiteScanProposalStore } from './infrastructure/sqlite/sqlite.scan.store';
import { VaultSyncer } from './infrastructure/vault/vault.syncer';
import { ConfigController } from './interfaces/config.controller';
import { NoteController } from './interfaces/note.controller';
import { createRouter } from './interfaces/router';
import { ScanController } from './interfaces/scan.controller';
import { ThemeController } from './interfaces/theme.controller';

type QueueProviderWithConsumer = IQueueProvider & {
  onMessage(callback: (id: string) => void | Promise<void>): void;
};

const EMBEDDING_DIMS: Partial<Record<string, number>> = {
  // providers (fallback)
  openai: 1536,
  ollama: 768,
  // models (checked first — more specific)
  'nomic-embed-text': 768,
  'mxbai-embed-large': 1024,
  'all-minilm': 384,
  'all-minilm:l6-v2': 384,
  'snowflake-arctic-embed': 1024,
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
};

type CreateAppOptions = {
  notesDbPath?: string;
  port?: string | number;
  requiresLLM?: boolean;
  createDatabase?: (path: string) => ReturnType<typeof createDatabase>;
  lancedbPath?: string;
  createVectorStore?: (path: string, dim?: number) => Promise<IVectorStore>;
  createQueueProvider?: () => QueueProviderWithConsumer;
  activeProvider?: ApiProviderName; // test injection — overrides userConfig.defaultProvider
  createOllamaClient?: () => ILLMClient;
  createEmbeddingClient?: () => IEmbeddingClient;
};

type ServeOptions = {
  port: string | number;
  fetch: (req: Request) => Promise<Response>;
};

async function createInfrastructure(options: CreateAppOptions) {
  const home = process.env.HOME || process.env.USERPROFILE || '.';
  const notesDbPath =
    options.notesDbPath ?? process.env.NOTECAST_DB_PATH ?? `${home}/.notecast/notes.db`;
  const lancedbPath =
    options.lancedbPath ??
    process.env.NOTECAST_LANCEDB_PATH ??
    notesDbPath.replace(/\.db$/, '.lancedb');
  const openDatabase = options.createDatabase ?? createDatabase;
  const db = openDatabase(notesDbPath);

  // Read config before opening vector store so we can derive embedding dims
  const configForDims = new SQLiteUserConfigRepository(db);
  const userConfigSnapshot = await configForDims.get();
  const embeddingProvider =
    userConfigSnapshot.llmConfig?.embedding?.provider ??
    userConfigSnapshot.defaultProvider ??
    'ollama';
  const embeddingModel = userConfigSnapshot.llmConfig?.embedding?.model;
  const embeddingDim =
    (embeddingModel && EMBEDDING_DIMS[embeddingModel]) ?? EMBEDDING_DIMS[embeddingProvider] ?? 768;

  const openVectorStore =
    options.createVectorStore ?? LanceDBVectorStore.open.bind(LanceDBVectorStore);
  const vectorStore = await openVectorStore(lancedbPath, embeddingDim);

  const ollamaClient = (options.createOllamaClient ?? (() => new OllamaClient()))();
  const embeddingClient = (options.createEmbeddingClient ?? (() => new OllamaEmbeddingClient()))();
  const clientRegistry = createClientRegistry(ollamaClient);
  const embeddingRegistry = createEmbeddingRegistry(embeddingClient);

  return {
    notesDbPath,
    noteRepository: new SQLiteNoteRepository(db, vectorStore),
    themeRepository: new SQLiteThemeRepository(db, vectorStore),
    scanProposalStore: new SQLiteScanProposalStore(db),
    userConfigRepository: new SQLiteUserConfigRepository(db),
    queueProvider: (options.createQueueProvider ?? (() => new SimpleMemoryQueue()))(),
    ollamaClient,
    embeddingClient,
    clientRegistry,
    embeddingRegistry,
    activeProvider: (options.activeProvider ??
      userConfigSnapshot.defaultProvider ??
      null) as ApiProviderName | null,
    availableProviders: detectAvailableProviders()
      .filter((p) => p.available)
      .map((p) => p.name),
  };
}

function createUseCases(infrastructure: Awaited<ReturnType<typeof createInfrastructure>>) {
  return {
    createNoteUseCase: new CreateNoteUseCase(
      infrastructure.noteRepository,
      infrastructure.queueProvider,
    ),
    createNotesBatchUseCase: new CreateNotesBatchUseCase(
      infrastructure.noteRepository,
      infrastructure.queueProvider,
    ),
    getNoteUseCase: new GetNoteUseCase(infrastructure.noteRepository),
    listNotesUseCase: new ListNotesUseCase(infrastructure.noteRepository),
    editNoteUseCase: new EditNoteUseCase(
      infrastructure.noteRepository,
      infrastructure.themeRepository,
      infrastructure.queueProvider,
    ),
    deleteNoteUseCase: new DeleteNoteUseCase(
      infrastructure.noteRepository,
      infrastructure.themeRepository,
    ),
    retryFailedNotesUseCase: new RetryFailedNotesUseCase(
      infrastructure.noteRepository,
      infrastructure.queueProvider,
    ),
    getConfigUseCase: new GetConfigUseCase(infrastructure.userConfigRepository),
    updateConfigUseCase: new UpdateConfigUseCase(
      infrastructure.userConfigRepository,
      infrastructure.themeRepository,
      infrastructure.embeddingClient,
    ),
    resetUseCase: new ResetUseCase(
      infrastructure.noteRepository,
      infrastructure.themeRepository,
      infrastructure.scanProposalStore,
      infrastructure.userConfigRepository,
      infrastructure.queueProvider,
      infrastructure.embeddingClient,
    ),
    classifyScanUseCase: new ClassifyScanUseCase(
      infrastructure.noteRepository,
      infrastructure.themeRepository,
      infrastructure.clientRegistry,
      infrastructure.activeProvider ?? undefined,
      infrastructure.userConfigRepository,
    ),
    organizeScanUseCase: new OrganizeScanUseCase(
      infrastructure.noteRepository,
      infrastructure.themeRepository,
      infrastructure.clientRegistry,
      infrastructure.activeProvider ?? undefined,
      infrastructure.userConfigRepository,
      infrastructure.embeddingClient,
    ),
    noteGraphUseCase: new NoteGraphUseCase(infrastructure.noteRepository),
    consolidateScanUseCase: new ConsolidateScanUseCase(
      infrastructure.noteRepository,
      infrastructure.themeRepository,
      infrastructure.clientRegistry,
      infrastructure.activeProvider ?? undefined,
      infrastructure.userConfigRepository,
      infrastructure.embeddingClient,
    ),
    createThemeUseCase: new CreateThemeUseCase(
      infrastructure.themeRepository,
      infrastructure.embeddingClient,
    ),
    deleteThemeUseCase: new DeleteThemeUseCase(
      infrastructure.themeRepository,
      infrastructure.noteRepository,
    ),
    listThemesUseCase: new ListThemesUseCase(infrastructure.themeRepository),
    updateThemeUseCase: new UpdateThemeUseCase(
      infrastructure.themeRepository,
      infrastructure.embeddingClient,
    ),
    assignNoteToThemeUseCase: new AssignNoteToThemeUseCase(
      infrastructure.noteRepository,
      infrastructure.themeRepository,
    ),
    removeNoteFromThemeUseCase: new RemoveNoteFromThemeUseCase(
      infrastructure.noteRepository,
      infrastructure.themeRepository,
    ),
    mergeThemesUseCase: new MergeThemesUseCase(
      infrastructure.themeRepository,
      infrastructure.noteRepository,
    ),
  };
}

function createScanRuntime(
  infrastructure: Awaited<ReturnType<typeof createInfrastructure>>,
  useCases: ReturnType<typeof createUseCases>,
  queueProvider?: QueueProviderWithConsumer,
) {
  const scanPipeline = new ScanPipeline(
    useCases.classifyScanUseCase,
    useCases.organizeScanUseCase,
    useCases.consolidateScanUseCase,
    useCases.noteGraphUseCase,
    infrastructure.scanProposalStore,
  );
  const scanOrchestrator = new ScanOrchestrator(
    infrastructure.noteRepository,
    infrastructure.scanProposalStore,
    infrastructure.userConfigRepository,
    scanPipeline,
    useCases.noteGraphUseCase,
    useCases.organizeScanUseCase,
  );
  const noteProcessor = new NoteProcessor(
    infrastructure.noteRepository,
    infrastructure.clientRegistry,
    infrastructure.embeddingClient,
    scanOrchestrator,
    queueProvider,
    infrastructure.userConfigRepository,
    infrastructure.activeProvider ?? undefined,
    infrastructure.embeddingRegistry,
  );

  if (queueProvider) {
    queueProvider.onMessage((id) => noteProcessor.process(id));
  }

  return { scanPipeline, scanOrchestrator, noteProcessor };
}

function createHttpApp(
  infrastructure: Awaited<ReturnType<typeof createInfrastructure>>,
  useCases: ReturnType<typeof createUseCases>,
  scanRuntime: ReturnType<typeof createScanRuntime>,
) {
  const noteController = new NoteController(
    useCases.createNoteUseCase,
    useCases.createNotesBatchUseCase,
    useCases.getNoteUseCase,
    useCases.listNotesUseCase,
    useCases.editNoteUseCase,
    useCases.deleteNoteUseCase,
    useCases.retryFailedNotesUseCase,
  );
  const scanController = new ScanController(
    useCases.classifyScanUseCase,
    useCases.organizeScanUseCase,
    useCases.noteGraphUseCase,
    useCases.consolidateScanUseCase,
    infrastructure.scanProposalStore,
    scanRuntime.scanOrchestrator,
    infrastructure.userConfigRepository,
    scanRuntime.scanPipeline,
  );
  const httpVaultSyncer = new VaultSyncer(
    infrastructure.noteRepository,
    infrastructure.themeRepository,
    infrastructure.userConfigRepository,
    infrastructure.scanProposalStore,
  );
  scanRuntime.scanPipeline.setVaultSyncer(httpVaultSyncer);
  noteController.setVaultSync(() => httpVaultSyncer.sync());
  scanController.setVaultSync(() => httpVaultSyncer.sync());
  const configController = new ConfigController(
    useCases.getConfigUseCase,
    useCases.updateConfigUseCase,
    useCases.resetUseCase,
    () => infrastructure.availableProviders,
    () => httpVaultSyncer.sync(),
  );

  const themeController = new ThemeController(
    useCases.createThemeUseCase,
    useCases.deleteThemeUseCase,
    useCases.listThemesUseCase,
    useCases.updateThemeUseCase,
    useCases.assignNoteToThemeUseCase,
    useCases.removeNoteFromThemeUseCase,
    useCases.mergeThemesUseCase,
  );

  return createRouter(noteController, scanController, configController, themeController, () => ({
    active: infrastructure.activeProvider,
    available: infrastructure.availableProviders,
  }));
}

export async function createHeadless(options: CreateAppOptions = {}) {
  const infrastructure = await createInfrastructure(options);

  if (options.requiresLLM && !infrastructure.activeProvider) {
    throw new Error(
      'No LLM provider configured. Run one of:\n' +
        '  notecast login <provider>             (openai | anthropic | gemini | deepseek)\n' +
        '  notecast codex-login                  (ChatGPT Pro OAuth)\n' +
        '  notecast config set defaultProvider ollama',
    );
  }

  const useCases = createUseCases(infrastructure);
  // no queueProvider: CLI calls process() directly, no auto-retries
  const { scanPipeline, scanOrchestrator, noteProcessor } = createScanRuntime(
    infrastructure,
    useCases,
  );
  const vaultSyncer = new VaultSyncer(
    infrastructure.noteRepository,
    infrastructure.themeRepository,
    infrastructure.userConfigRepository,
    infrastructure.scanProposalStore,
  );
  scanPipeline.setVaultSyncer(vaultSyncer);

  return {
    ...useCases,
    noteProcessor,
    vaultSyncer,
    scanProposalStore: infrastructure.scanProposalStore,
    userConfigRepository: infrastructure.userConfigRepository,
    noteRepository: infrastructure.noteRepository,
    themeRepository: infrastructure.themeRepository,
    scanOrchestrator,
    scanPipeline,
    createThemeUseCase: useCases.createThemeUseCase,
    deleteThemeUseCase: useCases.deleteThemeUseCase,
    listThemesUseCase: useCases.listThemesUseCase,
  };
}

export async function createApp(options: CreateAppOptions = {}) {
  const infrastructure = await createInfrastructure(options);

  if (!infrastructure.activeProvider) {
    throw new Error(
      'No LLM provider configured. Run one of:\n' +
        '  notecast login <provider>             (openai | anthropic | gemini | deepseek)\n' +
        '  notecast codex-login                  (ChatGPT Pro OAuth)\n' +
        '  notecast config set defaultProvider ollama',
    );
  }

  const useCases = createUseCases(infrastructure);
  const scanRuntime = createScanRuntime(infrastructure, useCases, infrastructure.queueProvider);

  const pendingNotes = await infrastructure.noteRepository.findByStatus('pending');
  if (pendingNotes.length > 0) {
    const log = logger.child('Bootstrap');
    log.info('Startup recovery: re-enqueuing pending notes', { count: pendingNotes.length });
    for (const note of pendingNotes) {
      await infrastructure.queueProvider.enqueue(note.id);
    }
  }

  const handleRequest = createHttpApp(infrastructure, useCases, scanRuntime);
  const port = options.port ?? process.env.PORT ?? 3000;

  return {
    handleRequest,
    port,
    notesDbPath: infrastructure.notesDbPath,
    startServer(serve = Bun.serve as (options: ServeOptions) => unknown) {
      return serve({
        port,
        fetch: handleRequest,
      });
    },
  };
}
