import type { IUserConfigRepository } from '../../../domain/config/config.types';
import type { ILLMClient, LLMProvider } from '../../../domain/llm/llm.types';
import type { Language, Prompts } from '../../../domain/llm/prompts';
import { getPrompts } from '../../../domain/llm/prompts';
import type { INoteRepository, Note } from '../../../domain/note/note.entity';
import type { CommitResult, IScan, ScanResult } from '../../../domain/scan/scan.types';
import type { UnifiedProposal } from '../../../domain/scan/unified.proposal';
import type { IThemeRepository, Theme } from '../../../domain/theme/theme.entity';
import {
  centroid,
  clusterByCosine,
  cosine,
  topKSimilarTo,
} from '../../../domain/vector/vector.utils';
import { resolveStepClient } from '../../../infrastructure/llm/clients/llm.factory';
import { logger } from '../../../infrastructure/logger';
import {
  computeInteriorNodeIds,
  computeThemeCentroids,
  weightedAffinity,
} from '../shared/scan.shared';
import { applyUnifiedProposal } from '../shared/unified.apply';
import { classifyToUnified } from './classify.mapper';

// No-op test helper (kept for parity with organize/consolidate usecase exports)
const _clearContextMdCacheForTest = () => {};

export { _clearContextMdCacheForTest };

const log = logger.child('Classify');

interface ClassifyLlmOutput {
  assignments: { noteId: string; themeNames: string[] }[];
}

export function getStyleInstruction(config: {
  themeStyle: string;
  themeStyleInstruction?: string;
  language?: Language;
}): string {
  if (config.themeStyle === 'custom') return config.themeStyleInstruction ?? '';
  return getPrompts(config.language ?? 'english').styleInstructions[config.themeStyle] ?? '';
}

export const CLASSIFY_HINT_THRESHOLD = 0.7;
export const CLASSIFY_HINT_TOP_K = 5;
export const CLASSIFY_MAX_BATCH = 5;

function parseProposal(raw: string): ClassifyLlmOutput | null {
  const cleaned = raw
    .replace(/```json?\s*/g, '')
    .replace(/```\s*$/g, '')
    .trim();
  try {
    const parsed = JSON.parse(cleaned) as ClassifyLlmOutput;
    if (!Array.isArray(parsed.assignments)) return null;
    return {
      assignments: parsed.assignments.map((a) => ({
        noteId: String(a.noteId ?? ''),
        themeNames: Array.isArray(a.themeNames) ? a.themeNames.map(String) : [],
      })),
    };
  } catch {
    return null;
  }
}

function mergeProposals(proposals: ClassifyLlmOutput[]): ClassifyLlmOutput {
  const allAssignments: ClassifyLlmOutput['assignments'] = [];
  for (const p of proposals) {
    allAssignments.push(...p.assignments);
  }
  return { assignments: allAssignments };
}

/**
 * For each new note, finds the top-k similar notes that were already classified and formats them as a hint.
 * Exported for testability.
 * @returns Map<noteId, hintLine> — hintLine is empty when there is no similar note
 */
export function buildClassifyHints(
  newNotes: Note[],
  classifiedNotes: Note[],
  themeMap: Map<string, Theme>,
  threshold: number,
  k: number,
): Map<string, string> {
  const classifiedMap = new Map(classifiedNotes.map((n) => [n.id, n]));
  const result = new Map<string, string>();
  for (const note of newNotes) {
    const similar = topKSimilarTo(note, classifiedNotes, threshold, k);
    const parts: string[] = [];
    for (const simId of similar) {
      const simNote = classifiedMap.get(simId);
      if (!simNote?.themeIds?.length) continue;
      const themeNames = simNote.themeIds
        .map((id) => themeMap.get(id)?.name)
        .filter(Boolean)
        .join(', ');
      if (!themeNames) continue;
      parts.push(`"${simNote.title}" → theme: "${themeNames}"`);
    }
    result.set(note.id, parts.join(' | '));
  }
  return result;
}

export class ClassifyScanUseCase implements IScan {
  readonly type = 'classify' as const;

  constructor(
    private noteRepository: INoteRepository,
    private themeRepository: IThemeRepository,
    private clientRegistry?: Record<LLMProvider, ILLMClient>,
    private defaultProvider?: LLMProvider,
    private configRepository?: IUserConfigRepository,
  ) {}

  private async resolveStep(): Promise<ILLMClient | undefined> {
    if (!this.clientRegistry || !this.defaultProvider) return undefined;
    const config = this.configRepository ? await this.configRepository.get() : null;
    return resolveStepClient(
      this.clientRegistry,
      this.defaultProvider,
      config?.llmConfig?.classify,
    );
  }

  private async buildSystemPrompt(): Promise<[string, Prompts]> {
    const parts: string[] = [];
    let prompts = getPrompts('english');
    if (this.configRepository) {
      const config = await this.configRepository.get();
      prompts = getPrompts(config.language ?? 'english');
      parts.push(prompts.classifyBase);
      const styleInstruction = getStyleInstruction(config);
      if (styleInstruction) parts.push(styleInstruction);
      if (config.context?.trim()) parts.push(`\n${prompts.contextLabel}\n${config.context.trim()}`);
    } else {
      parts.push(prompts.classifyBase);
    }
    return [parts.join('\n'), prompts];
  }

  private async buildBaseThemesSection(prompts: Prompts): Promise<string> {
    if (!this.configRepository) return '';
    const config = await this.configRepository.get();
    if (config.baseThemes.length === 0) return '';
    const lines = config.baseThemes.map(
      (bt) => `- ${bt.name}${bt.description ? `: ${bt.description}` : ''}`,
    );
    return `\n${prompts.baseThemesHeader}\n${lines.join('\n')}\n`;
  }

  private async callCodexBatch(
    client: ILLMClient,
    themeContext: string,
    notes: Note[],
    systemPrompt: string,
    baseThemesSection: string,
    hints: Map<string, string>,
    prompts: Prompts,
  ): Promise<ClassifyLlmOutput | null> {
    const { summaryLabel, noSummaryLabel, topicsLabel, noTopicsLabel } =
      prompts.noteFormatterLabels;
    const notesPayload = notes
      .map((n) => {
        const base = `[ID: ${n.id}] "${n.title}"\n${summaryLabel} ${n.summary || noSummaryLabel}\n${topicsLabel} ${n.topics.length > 0 ? n.topics.join(', ') : noTopicsLabel}`;
        const hint = hints.get(n.id);
        return hint ? `${base}\n${prompts.classifyHintLabel} ${hint}` : base;
      })
      .join('\n\n---\n\n');

    const userPrompt = `${prompts.classifyThemesHeader}
${themeContext}
${baseThemesSection}
${prompts.classifyNotesHeader}
${notesPayload}

${prompts.classifyJsonSchema}

${prompts.classifyAssignmentsNote}`;

    try {
      const response = await client.chat(userPrompt, {
        instructions: systemPrompt,
        responseFormat: 'json',
      });
      const proposal = parseProposal(response);
      if (!proposal) return null;
      const allowedIds = new Set(notes.map((n) => n.id));
      proposal.assignments = proposal.assignments.filter((a) => {
        if (!allowedIds.has(a.noteId)) {
          log.warn('Dropping assignment, unknown noteId', { noteId: a.noteId });
          return false;
        }
        return true;
      });
      if (proposal.assignments.length === 0) return null;
      return proposal;
    } catch (e) {
      log.warn('Classify batch failed', { err: e instanceof Error ? e : new Error(String(e)) });
      return null;
    }
  }

  private static readonly RELEVANT_THEMES_K = 15;
  private static readonly PER_NOTE_K = 3;

  /**
   * Selects theme IDs for full-detail display using per-note union.
   * Each note votes for its top-PER_NOTE_K nearest themes individually, preventing
   * batch-centroid dilution when notes cover diverse topics. Fills remaining slots
   * with batch-centroid ranking if under the cap.
   */
  private selectBatchThemeIds(
    batch: Note[],
    themes: Theme[],
    themeCentroids: Map<string, number[]>,
    interiorIds: Set<string>,
  ): Set<string> {
    if (themes.length <= ClassifyScanUseCase.RELEVANT_THEMES_K)
      return new Set(themes.map((t) => t.id));
    const batchVectors = batch.map((n) => n.contentVector).filter((v) => v.length > 0);
    if (batchVectors.length === 0) return new Set(themes.map((t) => t.id));

    const selectedIds = new Set<string>();
    for (const note of batch) {
      if (note.contentVector.length === 0) continue;
      themes
        .map((t) => ({
          id: t.id,
          score: themeCentroids.has(t.id)
            ? weightedAffinity(
                cosine(note.contentVector, themeCentroids.get(t.id)!),
                t.id,
                interiorIds,
              )
            : 0,
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, ClassifyScanUseCase.PER_NOTE_K)
        .forEach((s) => selectedIds.add(s.id));
    }

    if (selectedIds.size < ClassifyScanUseCase.RELEVANT_THEMES_K) {
      const batchCent = centroid(batchVectors);
      themes
        .map((t) => ({
          id: t.id,
          score: themeCentroids.has(t.id)
            ? weightedAffinity(cosine(batchCent, themeCentroids.get(t.id)!), t.id, interiorIds)
            : 0,
        }))
        .sort((a, b) => b.score - a.score)
        .forEach((s) => {
          if (selectedIds.size < ClassifyScanUseCase.RELEVANT_THEMES_K) selectedIds.add(s.id);
        });
    }

    return selectedIds;
  }

  /** Builds per-batch theme context. Returns context string and selected IDs. */
  private buildBatchThemeContext(
    batch: Note[],
    themes: Theme[],
    themeCentroids: Map<string, number[]>,
    interiorIds: Set<string>,
    hintThemeIds: Set<string> | undefined,
    prompts: Prompts,
  ): { context: string; selectedIds: Set<string> } {
    if (themes.length === 0)
      return { context: prompts.classifyNoThemesLabel, selectedIds: new Set() };
    const fullLine = (t: Theme) => `- ${t.name}${t.description ? `: ${t.description}` : ''}`;

    const selectedIds = this.selectBatchThemeIds(batch, themes, themeCentroids, interiorIds);

    // Promote hint-referenced themes (kNN signal) into full detail — replaces separate hint section.
    if (hintThemeIds) {
      for (const id of hintThemeIds) selectedIds.add(id);
    }

    // Promote children of selected parents to full detail so the LLM always sees
    // the most specific options when a parent is in context.
    for (const t of themes) {
      if (!selectedIds.has(t.id) && t.parentIds.some((pid) => selectedIds.has(pid))) {
        selectedIds.add(t.id);
      }
    }

    const selected = themes.filter((t) => selectedIds.has(t.id));
    const rest = themes.filter((t) => !selectedIds.has(t.id));

    const relevantLines = selected.map(fullLine).join('\n');
    const restNames = rest.map((t) => t.name).join(', ');
    const context = restNames
      ? `${relevantLines}\n\n${prompts.classifyOtherThemesLabel} ${restNames}`
      : relevantLines;
    return { context, selectedIds };
  }

  async generateProposal(preloadedNotes?: Note[]): Promise<ClassifyLlmOutput | null> {
    const allProcessed = preloadedNotes ?? (await this.noteRepository.findByStatus('processed'));
    const limit = this.configRepository
      ? (await this.configRepository.get()).pipelineConfig.classifyEvery
      : allProcessed.length;
    const notes = allProcessed.slice(0, limit);
    const themes = await this.themeRepository.findAll();

    const client = await this.resolveStep();
    if (!client || notes.length === 0) return null;

    // Load already-classified notes for k-NN hints
    const [scannedNotes, organizedNotes] = await Promise.all([
      this.noteRepository.findByStatus('scanned'),
      this.noteRepository.findByStatus('organized'),
    ]);
    const classifiedNotes = [...scannedNotes, ...organizedNotes];
    const themeMapForHints = new Map(themes.map((t) => [t.id, t]));
    const hints = buildClassifyHints(
      notes,
      classifiedNotes,
      themeMapForHints,
      CLASSIFY_HINT_THRESHOLD,
      CLASSIFY_HINT_TOP_K,
    );

    // Precompute theme centroids for per-batch relevance filtering.
    // Blends note-centroid (0.7) with descriptionVector (0.3) for stability on sparse themes.
    // Falls back to descriptionVector alone when theme has no notes yet.
    const classifiedNoteMap = new Map(classifiedNotes.map((n) => [n.id, n]));
    const themeCentroids = computeThemeCentroids(themes, classifiedNoteMap);
    const interiorIds = computeInteriorNodeIds(themes);

    // Compute per-note hint theme IDs for the separate hint context section
    const hintThemeIdsPerNote = new Map<string, Set<string>>();
    for (const note of notes) {
      const similar = topKSimilarTo(
        note,
        classifiedNotes,
        CLASSIFY_HINT_THRESHOLD,
        CLASSIFY_HINT_TOP_K,
      );
      const themeIds = new Set<string>();
      for (const simId of similar) {
        classifiedNoteMap.get(simId)?.themeIds?.forEach((id) => themeIds.add(id));
      }
      hintThemeIdsPerNote.set(note.id, themeIds);
    }

    const vectorized = notes.filter((n) => n.contentVector.length > 0);
    const unclustered = notes.filter((n) => n.contentVector.length === 0);
    const clusters = clusterByCosine(vectorized);
    const rawBatches: Note[][] = [...clusters];
    if (unclustered.length > 0) rawBatches.push(unclustered);

    // Cap each batch at 5 notes
    const batches: Note[][] = [];
    for (const batch of rawBatches) {
      for (let i = 0; i < batch.length; i += CLASSIFY_MAX_BATCH) {
        batches.push(batch.slice(i, i + CLASSIFY_MAX_BATCH));
      }
    }

    log.info('Classify batches ready', {
      notes: notes.length,
      clusters: clusters.length,
      unclustered: unclustered.length,
      batches: batches.length,
      maxBatch: CLASSIFY_MAX_BATCH,
    });

    const [systemPrompt, prompts] = await this.buildSystemPrompt();
    const baseThemesSection = await this.buildBaseThemesSection(prompts);

    const proposals: ClassifyLlmOutput[] = [];
    let failedBatches = 0;
    for (const batch of batches) {
      // Aggregate hint theme IDs for this batch
      const batchHintThemeIds = new Set<string>();
      for (const note of batch) {
        hintThemeIdsPerNote.get(note.id)?.forEach((id) => batchHintThemeIds.add(id));
      }
      const { context: themeContext } = this.buildBatchThemeContext(
        batch,
        themes,
        themeCentroids,
        interiorIds,
        batchHintThemeIds,
        prompts,
      );
      const proposal = await this.callCodexBatch(
        client,
        themeContext,
        batch,
        systemPrompt,
        baseThemesSection,
        hints,
        prompts,
      );
      if (proposal) proposals.push(proposal);
      else failedBatches++;
    }

    // If every batch failed (API error, model rejected, etc.) throw so the pipeline
    // treats this as a hard failure and does NOT re-queue classify — avoids infinite loop.
    if (batches.length > 0 && failedBatches === batches.length) {
      throw new Error(
        `All ${batches.length} classify batch(es) failed — check Codex API / model config`,
      );
    }

    return proposals.length === 0 ? null : mergeProposals(proposals);
  }

  async execute(): Promise<ScanResult> {
    const allProcessed = await this.noteRepository.findByStatus('processed');
    const limit = this.configRepository
      ? (await this.configRepository.get()).pipelineConfig.classifyEvery
      : allProcessed.length;
    const notes = allProcessed.slice(0, limit);
    const rawProposal = await this.generateProposal(allProcessed);

    const result: ScanResult = {
      scanType: 'classify',
      notesProcessed: notes.length,
      notes,
      executedAt: new Date(),
    };
    if (rawProposal) {
      const unified = await classifyToUnified(
        rawProposal,
        this.themeRepository,
        this.noteRepository,
      );
      result.unifiedProposal = unified;
    }
    return result;
  }

  async commit(proposal: UnifiedProposal): Promise<CommitResult> {
    // Propagate descriptions from base themes config
    if (this.configRepository) {
      const config = await this.configRepository.get();
      const themes = await this.themeRepository.findAll();
      const baseThemeMap = new Map(config.baseThemes.map((bt) => [bt.name, bt.description]));
      for (const t of themes) {
        const desc = baseThemeMap.get(t.name);
        if (desc && !t.description) {
          await this.themeRepository.update({ ...t, description: desc });
        }
      }
    }

    const applyResult = await applyUnifiedProposal(
      proposal,
      this.noteRepository,
      this.themeRepository,
    );

    return {
      themesCreated: applyResult.themesCreated,
      themesMerged: 0,
      notesUpdated: applyResult.assignmentsApplied,
      notesFinalized: applyResult.assignmentsApplied,
    };
  }
}
