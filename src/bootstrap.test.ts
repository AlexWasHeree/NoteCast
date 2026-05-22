import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, createHeadless } from './bootstrap';
import type { ChatOptions, IEmbeddingClient, ILLMClient } from './domain/llm/llm.types';
import type { IVectorStore, NoteVectors } from './domain/vector/vector.store';
import type { ApiProviderName } from './infrastructure/llm/clients/llm.factory';

class StubVectorStore implements IVectorStore {
  async upsertNoteVectors() {}
  async deleteNoteVectors() {}
  async resetNoteVectors() {}
  async findNoteVectorsByIds() {
    return new Map();
  }
  async findAllNoteVectors() {
    return new Map();
  }
  async knnByContentVector() {
    return [];
  }
  async knnBySummaryVector() {
    return [];
  }
  async upsertThemeVector() {}
  async deleteThemeVector() {}
  async resetThemeVectors() {}
  async findThemeVectorsByIds() {
    return new Map();
  }
  async findAllThemeVectors() {
    return new Map();
  }
  async knnByThemeVector() {
    return [];
  }
}

class StubLLMClient implements ILLMClient {
  async chat(_question: string, _options?: ChatOptions): Promise<string> {
    return 'stub summary';
  }
}

class StubEmbeddingClient implements IEmbeddingClient {
  async embed(_text: string): Promise<number[]> {
    return [0.1, 0.2, 0.3];
  }
}

class RecordingQueue {
  public readonly enqueued: string[] = [];

  onMessage(_callback: (id: string) => void | Promise<void>) {}

  async enqueue(noteId: string): Promise<void> {
    this.enqueued.push(noteId);
  }
}

describe('createHeadless()', () => {
  test('returns expected shape', async () => {
    const headless = await createHeadless({ notesDbPath: ':memory:', lancedbPath: ':memory:' });
    expect(typeof headless.createNoteUseCase.execute).toBe('function');
    expect(typeof headless.noteProcessor.process).toBe('function');
    expect(typeof headless.vaultSyncer.sync).toBe('function');
    expect(typeof headless.scanProposalStore.getPending).toBe('function');
  });
});

describe('createApp', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTempPaths() {
    const dir = mkdtempSync(join(tmpdir(), 'notecast-bootstrap-'));
    tempDirs.push(dir);
    return {
      notesDbPath: join(dir, 'notes.db'),
      lancedbPath: join(dir, 'notes.lancedb'),
    };
  }

  test('exposes a small bootstrap API while wiring note routes', async () => {
    const queue = new RecordingQueue();
    const app = await createApp({
      ...makeTempPaths(),
      createVectorStore: async () => new StubVectorStore(),
      createQueueProvider: () => queue,
      activeProvider: 'openai' as ApiProviderName,
      createOllamaClient: () => new StubLLMClient(),
      createEmbeddingClient: () => new StubEmbeddingClient(),
    });

    expect(typeof app.handleRequest).toBe('function');
    expect(typeof app.startServer).toBe('function');
    expect(app.notesDbPath.endsWith('notes.db')).toBe(true);

    const createResponse = await app.handleRequest(
      new Request('http://localhost/notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Bootstrap', content: 'manual DI' }),
      }),
    );

    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { id: string; title: string };
    expect(created.title).toBe('Bootstrap');
    expect(queue.enqueued).toEqual([created.id]);
  });

  test('delegates server startup to an injected serve adapter', async () => {
    const app = await createApp({
      ...makeTempPaths(),
      port: 4321,
      createVectorStore: async () => new StubVectorStore(),
      createQueueProvider: () => new RecordingQueue(),
      activeProvider: 'openai' as ApiProviderName,
      createOllamaClient: () => new StubLLMClient(),
      createEmbeddingClient: () => new StubEmbeddingClient(),
    });

    let captured: { port: string | number; fetch: (req: Request) => Promise<Response> } | null =
      null;
    const fakeServer = { stop() {} };
    const returned = app.startServer((options) => {
      captured = options;
      return fakeServer;
    });

    expect(returned).toBe(fakeServer);
    expect(app.port).toBe(4321);
    const c = captured!;
    expect(c.port).toBe(4321);

    const healthResponse = await c.fetch(new Request('http://localhost/health'));
    expect(healthResponse.status).toBe(200);
    expect(await healthResponse.text()).toBe('OK');
  });
});
