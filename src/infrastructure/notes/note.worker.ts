import keywordExtractor from 'keyword-extractor';
import type { IQueueProvider } from '../../application/notes/note.usecase';
import type { IUserConfigRepository } from '../../domain/config/config.types';
import type { IEmbeddingClient, ILLMClient, LLMProvider } from '../../domain/llm/llm.types';
import { getPrompts } from '../../domain/llm/prompts';
import { buildGraphEmbedText, buildMainEmbedText } from '../../domain/note/note.embedding-text';
import type { INoteRepository } from '../../domain/note/note.entity';
import type { INoteProcessedCallback } from '../../domain/note/note.processing';
import { GRAPH_THRESHOLD, GRAPH_TOP_K } from '../../domain/vector/vector.utils';
import { resolveEmbeddingClient, resolveStepClient } from '../llm/clients/llm.factory';
import { logger } from '../logger';

const log = logger.child('Worker');

const MAX_SUMMARY_RETRIES = 5;

function extractTopicsTs(title: string, content: string, language: string): string[] {
  const text = `${title}. ${content}`.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  return keywordExtractor.extract(text, {
    language: language as Parameters<typeof keywordExtractor.extract>[1] extends {
      language?: infer L;
    }
      ? L
      : never,
    remove_digits: true,
    return_changed_case: true,
    remove_duplicates: true,
  });
}

function extractTopicsSync(title: string, content: string, language: string): string[] {
  try {
    const result = Bun.spawnSync(['python3', 'scripts/extract_topics.py'], {
      stdin: Buffer.from(JSON.stringify({ title, content })),
      cwd: process.cwd(),
    });
    if (result.exitCode !== 0) return extractTopicsTs(title, content, language);
    const raw = result.stdout.toString().trim();
    const parsed = JSON.parse(raw) as string[];
    return parsed.length > 0 ? parsed : extractTopicsTs(title, content, language);
  } catch {
    return extractTopicsTs(title, content, language);
  }
}

export class NoteProcessor {
  private summaryRetryByNote = new Map<string, number>();

  constructor(
    private noteRepository: INoteRepository,
    private clientRegistry: Record<LLMProvider, ILLMClient>,
    private embeddingClient?: IEmbeddingClient,
    private orchestrator?: INoteProcessedCallback,
    private queueProvider?: IQueueProvider,
    private userConfigRepository?: IUserConfigRepository,
    private defaultSummaryProvider?: LLMProvider,
    private embeddingRegistry: Partial<Record<LLMProvider, IEmbeddingClient>> = {},
  ) {}

  async process(noteId: string) {
    const done = log.time('note.process');
    log.info('Processing note', { noteId });

    const note = await this.noteRepository.findById(noteId);
    if (!note) {
      log.warn('Note not found', { noteId });
      return;
    }

    // Step 1: summary via LLM
    const config = this.userConfigRepository ? await this.userConfigRepository.get() : null;
    const language = config?.language ?? 'english';
    const prompts = getPrompts(language);
    const summaryClient = resolveStepClient(
      this.clientRegistry,
      this.defaultSummaryProvider,
      config?.llmConfig?.summary,
    );
    if (summaryClient) {
      try {
        note.summary = await summaryClient.chat(
          `${prompts.summaryPromptLabels.titleLabel} ${note.title}\n\n${prompts.summaryPromptLabels.contentLabel}\n${note.content}`,
          {
            instructions: prompts.summary,
            temperature: 0.2,
            maxTokens: 220,
          },
        );
        const summaryProvider: LLMProvider =
          config?.llmConfig?.summary?.provider ?? this.defaultSummaryProvider;
        log.debug('Summary generated', { noteId, provider: summaryProvider });
      } catch (err) {
        log.warn('Summary failed, LLM unavailable', {
          noteId,
          err: err instanceof Error ? err : new Error(String(err)),
        });
        note.summary = '';
      }
      const trimmed = note.summary.trim();
      if (!trimmed) {
        const attempt = (this.summaryRetryByNote.get(noteId) ?? 0) + 1;
        this.summaryRetryByNote.set(noteId, attempt);
        if (attempt <= MAX_SUMMARY_RETRIES && this.queueProvider) {
          const delayMs = Math.min(30_000, 1500 * attempt);
          log.warn('Summary missing, retrying', {
            noteId,
            delayMs,
            attempt,
            maxRetries: MAX_SUMMARY_RETRIES,
          });
          setTimeout(() => void this.queueProvider?.enqueue(noteId), delayMs);
          return;
        }
        log.error('Summary generation failed after all retries', {
          noteId,
          attempts: MAX_SUMMARY_RETRIES,
        });
        this.summaryRetryByNote.delete(noteId);
        note.status = 'failed';
        note.failureReason = 'summary generation failed after all retries';
        await this.noteRepository.update(note);
        return;
      }
      this.summaryRetryByNote.delete(noteId);
      note.summary = trimmed;
    }

    // Step 2: topics via Python/YAKE (fallback: keyword-extractor)
    // language already resolved above
    note.topics = extractTopicsSync(note.title, note.content, language);
    log.debug('Topics extracted', { noteId, count: note.topics.length });

    // Step 3: two embeddings — main (scans) vs graph (neighbors)
    const embeddingClient = resolveEmbeddingClient(
      this.embeddingRegistry,
      this.embeddingClient,
      config?.llmConfig?.embedding,
      this.defaultSummaryProvider,
    );
    if (embeddingClient) {
      const mainText = buildMainEmbedText(note);
      const graphText = buildGraphEmbedText(note);
      const [mainVec, graphVec] = await Promise.all([
        embeddingClient.embed(mainText),
        embeddingClient.embed(graphText),
      ]);
      note.contentVector = mainVec;
      note.summaryVector = graphVec;
      log.debug('Embeddings computed', {
        noteId,
        mainDims: note.contentVector.length,
        graphDims: note.summaryVector.length,
      });
    } else {
      note.contentVector = [];
      note.summaryVector = [];
    }

    // Guard: re-verify note still exists before persisting (handles concurrent delete)
    const stillExists = await this.noteRepository.findById(noteId);
    if (!stillExists) {
      log.warn('Note deleted during processing', { noteId });
      return;
    }

    // Step 4: incremental graph — LanceDB KNN on summaryVector
    if (note.summaryVector.length > 0) {
      const relatedIds = await this.noteRepository.knnBySummaryVector(
        note.summaryVector,
        GRAPH_TOP_K,
        GRAPH_THRESHOLD,
      );
      note.relatedNoteIds = relatedIds.filter((id) => id !== note.id);
      log.debug('Related notes computed', { noteId, links: note.relatedNoteIds.length });
    }

    note.status = 'processed';
    await this.noteRepository.update(note);

    done({ noteId });

    if (this.orchestrator) {
      setImmediate(() =>
        this.orchestrator?.onNoteProcessed().catch((err) =>
          log.error('Orchestrator advance failed', {
            err: err instanceof Error ? err : new Error(String(err)),
          }),
        ),
      );
    }
  }
}
