import { beforeEach, describe, expect, test } from 'bun:test';
import type { IEmbeddingClient, ILLMClient } from '../../domain/llm/llm.types';
import type { Note } from '../../domain/note/note.entity';
import { InMemoryNoteRepository } from './adapters';
import { NoteProcessor } from './note.worker';

function makeNote(id: string, contentVector: number[], status: Note['status'] = 'processed'): Note {
  return {
    id,
    title: id,
    content: 'content',
    status,
    themeIds: [],
    createdAt: new Date(),
    summary: 'summary',
    topics: [],
    contentVector,
    summaryVector: [],
    relatedNoteIds: [],
  };
}

const stubLLM: ILLMClient = { chat: async () => 'summary text' };

describe('NoteProcessor — incremental graph', () => {
  let repo: InMemoryNoteRepository;

  beforeEach(() => {
    repo = new InMemoryNoteRepository();
  });

  test('sets relatedNoteIds after processing when similar notes exist', async () => {
    const existing = makeNote('existing', [1, 0, 0], 'processed');
    await repo.save(existing);

    const newNote = makeNote('new', [], 'pending');
    await repo.save(newNote);

    const stubEmbed: IEmbeddingClient = { embed: async () => [0.999, 0.001, 0] };
    const processor = new NoteProcessor(repo, stubLLM, stubEmbed);
    await processor.process('new');

    const saved = await repo.findById('new');
    expect(saved?.relatedNoteIds).toContain('existing');
  });

  test('relatedNoteIds is empty when no similar notes exist above threshold', async () => {
    const unrelated = makeNote('unrelated', [0, 0, 1], 'processed');
    await repo.save(unrelated);

    const newNote = makeNote('new', [], 'pending');
    await repo.save(newNote);

    const stubEmbed: IEmbeddingClient = { embed: async () => [1, 0, 0] };
    const processor = new NoteProcessor(repo, stubLLM, stubEmbed);
    await processor.process('new');

    const saved = await repo.findById('new');
    expect(saved?.relatedNoteIds).toHaveLength(0);
  });

  test('does not include the note itself in relatedNoteIds', async () => {
    const newNote = makeNote('self', [], 'pending');
    await repo.save(newNote);

    const stubEmbed: IEmbeddingClient = { embed: async () => [1, 0, 0] };
    const processor = new NoteProcessor(repo, stubLLM, stubEmbed);
    await processor.process('self');

    const saved = await repo.findById('self');
    expect(saved?.relatedNoteIds).not.toContain('self');
  });

  test('skips incremental graph when embedding client absent', async () => {
    const newNote = makeNote('new', [], 'pending');
    await repo.save(newNote);

    const processor = new NoteProcessor(repo, stubLLM); // no embeddingClient
    await processor.process('new');

    const saved = await repo.findById('new');
    expect(saved?.relatedNoteIds).toEqual([]);
  });
});
