import type { IUserConfigRepository } from '../../../domain/config/config.types';
import type { ILLMClient, LLMProvider } from '../../../domain/llm/llm.types';
import type { Prompts } from '../../../domain/llm/prompts';
import { getPrompts } from '../../../domain/llm/prompts';
import type { INoteRepository, Note } from '../../../domain/note/note.entity';
import type {
  CommitResult,
  IScan,
  MultiAssignment,
  ScanResult,
  StructureProposal,
} from '../../../domain/scan/scan.types';
import type { UnifiedProposal } from '../../../domain/scan/unified.proposal';
import type { IThemeRepository, Theme } from '../../../domain/theme/theme.entity';
import { cosine, topKSimilarTo } from '../../../domain/vector/vector.utils';
import { resolveStepClient } from '../../../infrastructure/llm/clients/llm.factory';
import { logger } from '../../../infrastructure/logger';
import { getStyleInstruction } from '../classify/classify.usecase';
import {
  buildScanSystemPrompt,
  computeInteriorNodeIds,
  computeThemeCentroids,
  llmValidateMultiAssign,
  type MultiAssignCandidate,
  weightedAffinity,
} from '../shared/scan.shared';
import { analyzeSplits } from '../shared/scan.splits';
import { applyUnifiedProposal, removeAncestorThemeIds } from '../shared/unified.apply';
import { organizeToUnified } from './organize.mapper';

const log = logger.child('Organize');

export const ORGANIZE_MULTI_ASSIGN_MIN_SCORE = 0.55;
export const ORGANIZE_MULTI_ASSIGN_ANCHOR_MIN_SCORE = 0.4;
const MULTI_ASSIGN_MAX_CANDIDATES = 40;
const MULTI_ASSIGN_BATCH = 5;

export class OrganizeScanUseCase implements IScan {
  readonly type = 'organize' as const;

  constructor(
    private noteRepository: INoteRepository,
    private themeRepository: IThemeRepository,
    private clientRegistry?: Record<LLMProvider, ILLMClient>,
    private defaultProvider?: LLMProvider,
    private configRepository?: IUserConfigRepository,
    private embeddingClient?: import('../../../domain/llm/llm.types').IEmbeddingClient,
  ) {}

  private async resolveStep(): Promise<ILLMClient | undefined> {
    if (!this.clientRegistry || !this.defaultProvider) return undefined;
    const config = this.configRepository ? await this.configRepository.get() : null;
    return resolveStepClient(
      this.clientRegistry,
      this.defaultProvider,
      config?.llmConfig?.organize,
    );
  }

  private async getContextMd(): Promise<string> {
    if (!this.configRepository) return '';
    const config = await this.configRepository.get();
    return config.context?.trim() ?? '';
  }

  private async getStyleInstruction(): Promise<string> {
    if (!this.configRepository) return '';
    const config = await this.configRepository.get();
    return getStyleInstruction(config);
  }

  private async getLangPrompts(): Promise<Prompts> {
    if (!this.configRepository) return getPrompts('english');
    const config = await this.configRepository.get();
    return getPrompts(config.language ?? 'english');
  }

  private buildSystemPrompt(
    baseSystem: string,
    phaseInstruction: string,
    contextMd: string,
    styleInstruction?: string,
    contextLabel?: string,
  ): string {
    return buildScanSystemPrompt(
      baseSystem,
      phaseInstruction,
      contextMd,
      styleInstruction,
      contextLabel,
    );
  }

  async generateProposal(): Promise<StructureProposal | null> {
    const scannedNotes = await this.noteRepository.findByStatus('scanned');
    const themes = await this.themeRepository.findAll();

    const client = await this.resolveStep();
    if (!client || scannedNotes.length === 0 || themes.length === 0) return null;

    const organizedNotes = await this.noteRepository.findByStatus('organized');
    const allNotes = [...scannedNotes, ...organizedNotes];
    const noteMap = new Map(allNotes.map((n) => [n.id, n]));
    const contextMd = await this.getContextMd();
    const prompts = await this.getLangPrompts();

    // Phase 1: Splits
    const styleInstruction = await this.getStyleInstruction();
    const splits = await analyzeSplits(
      themes,
      noteMap,
      client,
      prompts.organizeBase,
      contextMd,
      prompts.splitLabels,
      prompts.splitInstruction,
      prompts.splitDepthCaution,
      prompts.splitResidualNote,
      prompts.splitFallbackInstruction,
      prompts.splitJsonInstruction,
      styleInstruction,
    );

    // Phase 2: Multi-assign (scanned notes only — assign to additional themes)
    const multiAssignments = await this._analyzeMultiAssign(
      scannedNotes,
      themes,
      noteMap,
      contextMd,
      client,
      prompts,
    );

    log.info('Proposal generated', {
      splits: splits.length,
      multiAssigns: multiAssignments.length,
      themes: themes.length,
      notes: allNotes.length,
    });
    if (splits.length === 0 && multiAssignments.length === 0) return null;
    return { splits, merges: [], redistributions: [], multiAssignments };
  }

  // --- Multi-assign: assign scanned notes to additional themes ---
  private async _analyzeMultiAssign(
    notes: Note[],
    themes: Theme[],
    noteMap: Map<string, Note>,
    contextMd: string,
    client: ILLMClient,
    prompts: Prompts,
  ): Promise<MultiAssignment[]> {
    if (notes.length === 0 || themes.length < 2) return [];

    // Precompute effective theme centroids: blend notes (0.7) + description (0.3) for sparse themes,
    // fall back to descriptionVector alone for empty themes.
    const themeCentroids = computeThemeCentroids(themes, noteMap);
    const interiorIds = computeInteriorNodeIds(themes);

    // Resolve anchor theme IDs (user-created themes get a lower score threshold)
    const anchorThemeIds = new Set<string>();
    if (this.configRepository) {
      const config = await this.configRepository.get();
      const anchorNames = new Set(config.baseThemes.map((bt) => bt.name));
      for (const theme of themes) {
        if (anchorNames.has(theme.name)) anchorThemeIds.add(theme.id);
      }
    }

    // Find candidates: notes with affinity to non-assigned themes
    const candidates: MultiAssignCandidate[] = [];
    const allClassifiedNotes = [...noteMap.values()].filter((n) => n.contentVector.length > 0);

    const themeMapForAncestry = new Map(themes.map((t) => [t.id, t]));

    for (const note of notes) {
      if (note.contentVector.length === 0) continue;
      const currentThemeIds = new Set(note.themeIds ?? []);

      for (const theme of themes) {
        if (currentThemeIds.has(theme.id)) continue;
        // Skip themes with no signal at all (no notes, no description vector)
        if (theme.noteIds.length === 0 && !theme.descriptionVector?.length) continue;

        // Skip themes that are ancestors or descendants of the note's current themes
        // — they'd either be cleaned by removeAncestorThemeIds (ancestor) or already covered (descendant)
        const isRelatedToCurrentTheme = [...currentThemeIds].some((cid) => {
          const after = removeAncestorThemeIds([theme.id, cid], themeMapForAncestry);
          return after.length < 2;
        });
        if (isRelatedToCurrentTheme) continue;

        // 1. Cosine affinity to effective theme centroid
        const themeCentroid = themeCentroids.get(theme.id);
        const rawCosine = themeCentroid ? cosine(note.contentVector, themeCentroid) : 0;
        const cosineAffinity = weightedAffinity(rawCosine, theme.id, interiorIds);

        // 2. k-NN overlap: how many of note's top-5 similar notes belong to this theme
        const similarIds = topKSimilarTo(note, allClassifiedNotes, 0.7, 5);
        const knnInTheme = similarIds.filter((id) => theme.noteIds.includes(id)).length;
        const knnRatio = similarIds.length > 0 ? knnInTheme / similarIds.length : 0;

        // 3. Topic overlap: shared topics between note and theme's notes
        const themeTopics = new Set(theme.noteIds.flatMap((id) => noteMap.get(id)?.topics ?? []));
        const sharedTopics = note.topics.filter((t) => themeTopics.has(t));
        const topicOverlap = note.topics.length > 0 ? sharedTopics.length / note.topics.length : 0;

        // Composite score — normalize by available signal weights when theme has no notes
        const hasNotes = theme.noteIds.length > 0;
        const score = hasNotes
          ? 0.5 * cosineAffinity + 0.3 * knnRatio + 0.2 * topicOverlap
          : cosineAffinity; // only cosine available for empty themes

        const isAnchor = anchorThemeIds.has(theme.id);
        const minScore = isAnchor
          ? ORGANIZE_MULTI_ASSIGN_ANCHOR_MIN_SCORE
          : ORGANIZE_MULTI_ASSIGN_MIN_SCORE;

        if (score >= minScore) {
          const reasons: string[] = [];
          if (cosineAffinity >= 0.5)
            reasons.push(prompts.reasonLabels.affinity((cosineAffinity * 100).toFixed(0)));
          if (knnInTheme > 0)
            reasons.push(prompts.reasonLabels.neighbors(knnInTheme, similarIds.length));
          if (sharedTopics.length > 0)
            reasons.push(prompts.reasonLabels.topics(sharedTopics.slice(0, 3).join(', ')));
          if (!hasNotes) reasons.push(prompts.reasonLabels.semanticDesc);
          candidates.push({
            note,
            themeId: theme.id,
            themeName: theme.name,
            score,
            reason: reasons.join('; '),
            isAnchor,
          });
        }
      }
    }

    if (candidates.length === 0) return [];

    // Sort by score descending, cap at top N (anchors first within same score band)
    candidates.sort((a, b) => {
      if (a.isAnchor !== b.isAnchor) return a.isAnchor ? -1 : 1;
      return b.score - a.score;
    });
    const topCandidates = candidates.slice(0, MULTI_ASSIGN_MAX_CANDIDATES);

    // LLM validates in batches
    const themeMap = new Map(themes.map((t) => [t.id, t]));
    const systemPrompt = this.buildSystemPrompt(
      prompts.organizeBase,
      prompts.multiAssignInstruction,
      contextMd,
      undefined,
      prompts.contextLabel,
    );
    return llmValidateMultiAssign(
      topCandidates,
      themeMap,
      client,
      systemPrompt,
      MULTI_ASSIGN_BATCH,
      prompts.multiAssignLabels,
    );
  }

  async execute(): Promise<ScanResult> {
    const [scannedNotes, organizedNotes] = await Promise.all([
      this.noteRepository.findByStatus('scanned'),
      this.noteRepository.findByStatus('organized'),
    ]);
    const allNotes = [...scannedNotes, ...organizedNotes];
    const rawProposal = await this.generateProposal();

    const result: ScanResult = {
      scanType: 'organize',
      notesProcessed: allNotes.length,
      notes: allNotes,
      executedAt: new Date(),
    };
    if (rawProposal) {
      const unified = await organizeToUnified(
        rawProposal,
        this.themeRepository,
        this.noteRepository,
      );
      result.unifiedProposal = unified;
    }
    return result;
  }

  async commit(proposal: UnifiedProposal, noteIdsRead?: string[]): Promise<CommitResult> {
    const idsToFinalize =
      noteIdsRead ?? (await this.noteRepository.findByStatus('scanned')).map((n) => n.id);
    const applyResult = await applyUnifiedProposal(
      proposal,
      this.noteRepository,
      this.themeRepository,
      this.embeddingClient,
    );
    const notesUpdated =
      applyResult.notesMovedBySplits +
      applyResult.notesMovedByMerges +
      applyResult.redistributionsApplied;

    let notesFinalized = 0;
    for (const noteId of idsToFinalize) {
      const note = await this.noteRepository.findById(noteId);
      if (!note || note.status !== 'scanned') continue;
      await this.noteRepository.update({ ...note, status: 'organized' });
      notesFinalized++;
    }

    return {
      themesCreated: applyResult.themesCreated,
      themesMerged: applyResult.themesMerged,
      notesUpdated,
      notesFinalized,
    };
  }
}
