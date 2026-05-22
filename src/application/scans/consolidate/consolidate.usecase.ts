import type { IUserConfigRepository } from '../../../domain/config/config.types';
import type { ILLMClient, LLMProvider } from '../../../domain/llm/llm.types';
import type { Prompts } from '../../../domain/llm/prompts';
import { getPrompts } from '../../../domain/llm/prompts';
import type { INoteRepository, Note } from '../../../domain/note/note.entity';
import type {
  ConsolidateCommitResult,
  MultiAssignment,
  StructureProposal,
  ThemeConnection,
} from '../../../domain/scan/scan.types';
import type { UnifiedProposal } from '../../../domain/scan/unified.proposal';
import type { IThemeRepository, Theme } from '../../../domain/theme/theme.entity';
import { cosine, topKSimilarTo } from '../../../domain/vector/vector.utils';
import { resolveStepClient } from '../../../infrastructure/llm/clients/llm.factory';
import { logger } from '../../../infrastructure/logger';
import { getStyleInstruction } from '../classify/classify.usecase';
import { resolveThemeIdFromLlm } from '../shared/llm.theme.ref';
import {
  buildScanSystemPrompt,
  cleanJsonResponse,
  computeInteriorNodeIds,
  computeThemeCentroids,
  llmValidateMultiAssign,
  type MultiAssignCandidate,
  weightedAffinity,
} from '../shared/scan.shared';
import { analyzeSplits } from '../shared/scan.splits';
import { applyUnifiedProposal, removeAncestorThemeIds } from '../shared/unified.apply';
import { consolidateToUnified } from './consolidate.mapper';

const log = logger.child('Consolidate');

export const REROUTE_LINK_RATIO = 0.7; // was 0.50 — 4/5 neighbors must agree before rerouting
export const ADD_PARENT_THRESHOLD = 0.5;
export const REMOVE_PARENT_THRESHOLD = 0.1; // was 0.20 — too many false candidates on small graph
const ADD_PARENT_BATCH = 5;
const CONSOLIDATE_REROUTE_BATCH = 5;
export const CONSOLIDATE_AFFINITY_MIN_MARGIN = 0.2; // cross-branch: need stronger signal to move a note
export const CONSOLIDATE_AFFINITY_DEMOTION_MARGIN = 0.03; // same-branch demotion (parent→child): almost any improvement counts
const CONSOLIDATE_AFFINITY_MAX_CANDIDATES = 10; // was 20 — fewer moves per round
const CONSOLIDATE_AFFINITY_BATCH = 5;
export const CONSOLIDATE_MULTI_ASSIGN_MIN_SCORE = 0.6; // was 0.55 — stricter for already-organized notes
export const CONSOLIDATE_MULTI_ASSIGN_ANCHOR_MIN_SCORE = 0.4;
const MULTI_ASSIGN_MAX_CANDIDATES = 40;
const MULTI_ASSIGN_BATCH = 5;

// --- Exported helpers (tested independently) ---

export interface RerouteCandidate {
  noteId: string;
  fromThemeId: string;
  toThemeId: string;
  linkRatio: number;
}

export function computeRerouteCandidates(
  notes: Note[],
  noteMap: Map<string, Note>,
  themes: Theme[],
): RerouteCandidate[] {
  const themeIdSet = new Set(themes.map((t) => t.id));
  const candidates: RerouteCandidate[] = [];

  for (const note of notes) {
    const currentThemeIds = note.themeIds ?? [];
    if (currentThemeIds.length === 0) continue;
    if ((note.relatedNoteIds ?? []).length === 0) continue;

    const themeFreq = new Map<string, number>();
    let total = 0;
    for (const relatedId of note.relatedNoteIds) {
      const related = noteMap.get(relatedId);
      if (!related) continue;
      for (const themeId of related.themeIds ?? []) {
        if (themeIdSet.has(themeId)) {
          themeFreq.set(themeId, (themeFreq.get(themeId) ?? 0) + 1);
          total++;
        }
      }
    }

    if (total === 0) continue;

    let topThemeId = '';
    let topCount = 0;
    for (const [themeId, count] of themeFreq) {
      if (count > topCount) {
        topCount = count;
        topThemeId = themeId;
      }
    }

    const ratio = topCount / total;
    if (ratio < REROUTE_LINK_RATIO) continue;
    if (!topThemeId || currentThemeIds.includes(topThemeId)) continue;

    let fromThemeId = currentThemeIds[0];
    let minCount = Infinity;
    for (const themeId of currentThemeIds) {
      const count = themeFreq.get(themeId) ?? 0;
      if (count < minCount) {
        minCount = count;
        fromThemeId = themeId;
      }
    }

    if (fromThemeId === undefined) continue;
    candidates.push({ noteId: note.id, fromThemeId, toThemeId: topThemeId, linkRatio: ratio });
  }

  return candidates;
}

/**
 * For a theme T, compute what fraction of its notes also belong to each other theme.
 * Returns Map<otherThemeId, ratio> where ratio = overlapping notes / T.noteIds.length.
 */
export function computeCooccurrence(
  theme: Theme,
  noteMap: Map<string, Note>,
  themes: Theme[],
): Map<string, number> {
  const result = new Map<string, number>();
  if (theme.noteIds.length === 0) return result;

  const freq = new Map<string, number>();
  for (const noteId of theme.noteIds) {
    const note = noteMap.get(noteId);
    if (!note) continue;
    for (const tid of note.themeIds ?? []) {
      freq.set(tid, (freq.get(tid) ?? 0) + 1);
    }
  }

  for (const other of themes) {
    if (other.id === theme.id) continue;
    result.set(other.id, (freq.get(other.id) ?? 0) / theme.noteIds.length);
  }

  return result;
}

// --- Use Case ---

export class ConsolidateScanUseCase {
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
      config?.llmConfig?.consolidate,
    );
  }

  private async getContextMd(): Promise<string> {
    if (!this.configRepository) return '';
    const config = await this.configRepository.get();
    return config.context?.trim() ?? '';
  }

  private async getLangPrompts(): Promise<Prompts> {
    if (!this.configRepository) return getPrompts('english');
    const config = await this.configRepository.get();
    return getPrompts(config.language ?? 'english');
  }

  async generateProposal(): Promise<UnifiedProposal | null> {
    const client = await this.resolveStep();
    const notes = await this.noteRepository.findByStatus('organized');
    const themes = await this.themeRepository.findAll();

    const noteMap = new Map(notes.map((n) => [n.id, n]));
    const contextMd = await this.getContextMd();
    const prompts = await this.getLangPrompts();

    // Removals: empty leaf themes (no notes AND no children; protect base themes)
    const config = this.configRepository ? await this.configRepository.get() : null;
    const baseThemeNames = new Set(config?.baseThemes.map((bt) => bt.name) ?? []);
    const parentOfSomeone = new Set(themes.flatMap((t) => t.parentIds));
    const removals = themes
      .filter(
        (t) => t.noteIds.length === 0 && !baseThemeNames.has(t.name) && !parentOfSomeone.has(t.id),
      )
      .map((t) => t.id);

    if (!client) {
      const sp: StructureProposal = { splits: [], merges: [], redistributions: [], removals };
      return consolidateToUnified(sp, this.themeRepository, this.noteRepository);
    }

    // Precompute effective centroids: blend notes (0.7) + description (0.3) for sparse themes,
    // fall back to descriptionVector alone for empty themes.
    const themeCentroids = computeThemeCentroids(themes, noteMap);
    const interiorIds = computeInteriorNodeIds(themes);

    // Phase 0: Splits (themes that grew large enough across multiple cycles)
    const styleInstruction = config ? getStyleInstruction(config) : '';
    const splits = await analyzeSplits(
      themes,
      noteMap,
      client,
      prompts.consolidateBase,
      contextMd,
      prompts.splitLabels,
      prompts.splitInstruction,
      prompts.splitDepthCaution,
      prompts.splitResidualNote,
      prompts.splitFallbackInstruction,
      prompts.splitJsonInstruction,
      styleInstruction,
      15, // minNotesOverride: consolidate uses a high threshold — only split when a theme has accumulated real volume
    );

    // Phase 1: Graph-informed reroutes
    const rerouteCandidates = computeRerouteCandidates(notes, noteMap, themes);
    const graphRedistributions = await this._analyzeReroutes(
      rerouteCandidates,
      noteMap,
      themes,
      contextMd,
      client,
      prompts,
    );

    // Phase 2: Affinity redistributions
    const alreadyHandled = new Set(graphRedistributions.map((r) => r.noteId));
    const affinityRedistributions = await this._analyzeAffinityRedistributions(
      notes,
      themes,
      noteMap,
      themeCentroids,
      interiorIds,
      alreadyHandled,
      contextMd,
      client,
      prompts,
    );

    const redistributions = [...graphRedistributions, ...affinityRedistributions];

    // Phase 3: Co-occurrence connections
    const { addParents, removeParents } = await this._analyzeConnections(
      themes,
      noteMap,
      contextMd,
      client,
      prompts,
    );

    // Phase 4: Multi-assign (all organized notes — assign to additional themes)
    const multiAssignments = await this._analyzeMultiAssign(
      notes,
      themes,
      noteMap,
      themeCentroids,
      interiorIds,
      contextMd,
      client,
      prompts,
    );

    log.info('Proposal generated', {
      splits: splits.length,
      reroutes: graphRedistributions.length,
      affinity: affinityRedistributions.length,
      addParents: addParents.length,
      removeParents: removeParents.length,
      multiAssigns: multiAssignments.length,
      removals: removals.length,
    });

    const structureProposal: StructureProposal = {
      splits,
      merges: [],
      redistributions,
      removals,
      addParents,
      removeParents,
      multiAssignments,
    };
    return consolidateToUnified(structureProposal, this.themeRepository, this.noteRepository);
  }

  // --- Phase 1: Graph-informed reroutes ---
  // Uses relatedNoteIds to show neighbor context.
  // For each reroute candidate, shows the note, its graph neighbors and their themes.

  private async _analyzeReroutes(
    rerouteCandidates: RerouteCandidate[],
    noteMap: Map<string, Note>,
    themes: Theme[],
    contextMd: string,
    client: ILLMClient,
    prompts: Prompts,
  ): Promise<StructureProposal['redistributions']> {
    if (rerouteCandidates.length === 0) return [];

    const systemPrompt = buildScanSystemPrompt(
      prompts.consolidateBase,
      prompts.rerouteInstruction,
      contextMd,
      undefined,
      prompts.contextLabel,
    );

    const labels = prompts.rerouteLabels;
    const themeMap = new Map(themes.map((t) => [t.id, t]));
    const allRedist: StructureProposal['redistributions'] = [];

    for (let i = 0; i < rerouteCandidates.length; i += CONSOLIDATE_REROUTE_BATCH) {
      const batch = rerouteCandidates.slice(i, i + CONSOLIDATE_REROUTE_BATCH);

      const notesPayload = batch
        .map((c) => {
          const note = noteMap.get(c.noteId);
          if (!note) return '';
          const fromTheme = themeMap.get(c.fromThemeId);
          const toTheme = themeMap.get(c.toThemeId);

          // Graph context: show related notes and their themes
          const neighborLines = (note.relatedNoteIds ?? [])
            .slice(0, 5)
            .map((relId) => {
              const rel = noteMap.get(relId);
              if (!rel) return null;
              const relThemes = (rel.themeIds ?? [])
                .map((id) => themeMap.get(id)?.name)
                .filter(Boolean)
                .join(', ');
              return `    - "${rel.title}" → ${labels.relatedThemePrefix} ${relThemes || labels.noThemeLabel}`;
            })
            .filter(Boolean)
            .join('\n');

          return `${labels.noteLabel} [${note.id}] "${note.title}"
  ${labels.summaryLabel} ${note.summary || labels.noSummaryLabel}
  ${labels.topicsLabel} ${note.topics.join(', ') || labels.noTopicsLabel}
  ${labels.currentThemeLabel} [${c.fromThemeId}]: "${fromTheme?.name ?? '?'}"
  ${labels.suggestedThemeLabel} [${c.toThemeId}]: "${toTheme?.name ?? '?'}" (link ratio: ${c.linkRatio.toFixed(2)})
  ${labels.neighborsLabel}
${neighborLines || `    ${labels.noNeighborsLabel}`}`;
        })
        .filter(Boolean)
        .join('\n\n---\n\n');

      const userPrompt = `${notesPayload}\n\n${labels.jsonInstruction}`;

      try {
        const response = await client.chat(userPrompt, {
          instructions: systemPrompt,
          responseFormat: 'json',
        });
        const parsed = JSON.parse(cleanJsonResponse(response));
        if (Array.isArray(parsed.redistributions)) {
          for (const r of parsed.redistributions) {
            if (r.noteId && r.fromThemeId && r.toThemeId && r.fromThemeId !== r.toThemeId) {
              allRedist.push({
                noteId: String(r.noteId),
                fromThemeId: String(r.fromThemeId),
                toThemeId: String(r.toThemeId),
              });
            }
          }
        }
      } catch (e) {
        log.warn('Reroute analysis failed', { err: e instanceof Error ? e : new Error(String(e)) });
      }
    }

    return allRedist;
  }

  // --- Phase 2: Affinity redistributions ---
  // Catches notes that vectorially fit better in a different theme (especially newer themes
  // that didn't exist when the note was originally classified).
  // Uses relative ranking (margin = best_alternative - current) instead of absolute thresholds.

  private async _analyzeAffinityRedistributions(
    notes: Note[],
    themes: Theme[],
    _noteMap: Map<string, Note>,
    themeCentroids: Map<string, number[]>,
    interiorIds: Set<string>,
    alreadyHandled: Set<string>,
    contextMd: string,
    client: ILLMClient,
    prompts: Prompts,
  ): Promise<StructureProposal['redistributions']> {
    const themeMapForAncestry = new Map(themes.map((t) => [t.id, t]));

    // Check if candidateId is a descendant of fromId (demotion = moving to more specific)
    function isDemotion(fromId: string, candidateId: string): boolean {
      const after = removeAncestorThemeIds([fromId, candidateId], themeMapForAncestry);
      return after.length === 1 && after[0] === candidateId;
    }

    const dissatisfied: {
      note: Note;
      fromThemeId: string;
      currentAffinity: number;
      candidates: { themeId: string; name: string; affinity: number }[];
      margin: number;
    }[] = [];

    for (const note of notes) {
      if (note.contentVector.length === 0 || alreadyHandled.has(note.id)) continue;

      for (const fromThemeId of note.themeIds ?? []) {
        const fromCentroid = themeCentroids.get(fromThemeId);
        if (!fromCentroid) continue;
        const currentAffinity = weightedAffinity(
          cosine(note.contentVector, fromCentroid),
          fromThemeId,
          interiorIds,
        );

        const candidates: { themeId: string; name: string; affinity: number }[] = [];
        for (const theme of themes) {
          if ((note.themeIds ?? []).includes(theme.id)) continue;
          const c = themeCentroids.get(theme.id);
          if (!c) continue;
          const affinity = weightedAffinity(cosine(note.contentVector, c), theme.id, interiorIds);
          if (affinity > currentAffinity) {
            candidates.push({ themeId: theme.id, name: theme.name, affinity });
          }
        }

        if (candidates.length === 0) continue;
        candidates.sort((a, b) => b.affinity - a.affinity);
        const bestCandidate = candidates[0]!;
        const margin = bestCandidate.affinity - currentAffinity;
        const minMargin = isDemotion(fromThemeId, bestCandidate.themeId)
          ? CONSOLIDATE_AFFINITY_DEMOTION_MARGIN
          : CONSOLIDATE_AFFINITY_MIN_MARGIN;
        if (margin >= minMargin) {
          dissatisfied.push({
            note,
            fromThemeId,
            currentAffinity,
            candidates: candidates.slice(0, 3),
            margin,
          });
        }
      }
    }

    // Rank by dissatisfaction margin, take top N
    dissatisfied.sort((a, b) => b.margin - a.margin);
    const topCandidates = dissatisfied.slice(0, CONSOLIDATE_AFFINITY_MAX_CANDIDATES);
    if (topCandidates.length === 0) return [];

    const systemPrompt = buildScanSystemPrompt(
      prompts.consolidateBase,
      prompts.affinityInstruction,
      contextMd,
      undefined,
      prompts.contextLabel,
    );

    const labels = prompts.affinityLabels;
    const themeMap = new Map(themes.map((t) => [t.id, t]));
    const allRedist: StructureProposal['redistributions'] = [];

    for (let i = 0; i < topCandidates.length; i += CONSOLIDATE_AFFINITY_BATCH) {
      const batch = topCandidates.slice(i, i + CONSOLIDATE_AFFINITY_BATCH);

      const notesPayload = batch
        .map((o) => {
          const fromTheme = themeMap.get(o.fromThemeId);
          const candidateLines = o.candidates
            .map(
              (c) =>
                `    - [${c.themeId}] "${c.name}" (${labels.affinityLabel} ${c.affinity.toFixed(2)})`,
            )
            .join('\n');
          return `${labels.noteLabel} [${o.note.id}] "${o.note.title}"
  ${labels.summaryLabel} ${o.note.summary || labels.noSummaryLabel}
  ${labels.topicsLabel} ${o.note.topics.join(', ') || labels.noTopicsLabel}
  ${labels.currentThemeLabel} [${o.fromThemeId}]: "${fromTheme?.name ?? '?'}" (${labels.affinityLabel} ${o.currentAffinity.toFixed(2)})
  ${labels.marginLabel} +${o.margin.toFixed(2)}
  ${labels.candidatesLabel}\n${candidateLines}`;
        })
        .join('\n\n---\n\n');

      const userPrompt = `${notesPayload}\n\n${labels.jsonInstruction}`;

      try {
        const response = await client.chat(userPrompt, {
          instructions: systemPrompt,
          responseFormat: 'json',
        });
        const parsed = JSON.parse(cleanJsonResponse(response));
        if (Array.isArray(parsed.redistributions)) {
          for (const r of parsed.redistributions) {
            if (r.noteId && r.fromThemeId && r.toThemeId && r.fromThemeId !== r.toThemeId) {
              allRedist.push({
                noteId: String(r.noteId),
                fromThemeId: String(r.fromThemeId),
                toThemeId: String(r.toThemeId),
              });
            }
          }
        }
      } catch (e) {
        log.warn('Affinity analysis failed', {
          err: e instanceof Error ? e : new Error(String(e)),
        });
      }
    }

    return allRedist;
  }

  private async _analyzeConnections(
    themes: Theme[],
    noteMap: Map<string, Note>,
    contextMd: string,
    client: ILLMClient,
    prompts: Prompts,
  ): Promise<{ addParents: ThemeConnection[]; removeParents: ThemeConnection[] }> {
    const addCandidates: { theme: Theme; parentId: string; parentName: string; ratio: number }[] =
      [];
    const removeCandidates: {
      theme: Theme;
      parentId: string;
      parentName: string;
      ratio: number;
    }[] = [];
    const themeMap = new Map(themes.map((t) => [t.id, t]));

    for (const theme of themes) {
      if (theme.noteIds.length === 0) continue;
      const cooc = computeCooccurrence(theme, noteMap, themes);

      for (const [otherId, ratio] of cooc) {
        if (ratio >= ADD_PARENT_THRESHOLD && !theme.parentIds.includes(otherId)) {
          const other = themeMap.get(otherId);
          if (other)
            addCandidates.push({ theme, parentId: otherId, parentName: other.name, ratio });
        }
        // Only propose removeParent if the theme has 2+ parents (guard: never remove last parent)
        if (
          ratio <= REMOVE_PARENT_THRESHOLD &&
          theme.parentIds.includes(otherId) &&
          theme.parentIds.length >= 2
        ) {
          const other = themeMap.get(otherId);
          if (other)
            removeCandidates.push({ theme, parentId: otherId, parentName: other.name, ratio });
        }
      }
    }

    const addParents = await this._llmValidateConnections(
      addCandidates,
      'add',
      contextMd,
      themeMap,
      client,
      prompts,
    );
    const removeParents = await this._llmValidateConnections(
      removeCandidates,
      'remove',
      contextMd,
      themeMap,
      client,
      prompts,
    );

    return { addParents, removeParents };
  }

  private async _llmValidateConnections(
    candidates: { theme: Theme; parentId: string; parentName: string; ratio: number }[],
    action: 'add' | 'remove',
    contextMd: string,
    themeMap: Map<string, Theme>,
    client: ILLMClient,
    prompts: Prompts,
  ): Promise<ThemeConnection[]> {
    if (candidates.length === 0) return [];

    const verb = action === 'add' ? prompts.connectionsAddVerb : prompts.connectionsRemoveVerb;
    const reason = action === 'add' ? prompts.connectionsHighReason : prompts.connectionsLowReason;

    const systemPrompt = buildScanSystemPrompt(
      prompts.consolidateBase,
      prompts.connectionsAnalyzeInstruction(verb, reason, prompts.connectionsSemanticNote),
      contextMd,
      undefined,
      prompts.contextLabel,
    );

    const cLabels = prompts.connectionLabels;
    const connections: ThemeConnection[] = [];

    for (let i = 0; i < candidates.length; i += ADD_PARENT_BATCH) {
      const batch = candidates.slice(i, i + ADD_PARENT_BATCH);

      const payload = batch
        .map((c) => {
          const currentParents =
            c.theme.parentIds.map((pid) => themeMap.get(pid)?.name ?? pid).join(', ') ||
            cLabels.rootLabel;
          return `${cLabels.themeLabel} "${c.theme.name}" (${c.theme.noteIds.length} ${cLabels.notesSuffix})\n  ${cLabels.currentParentsLabel} [${currentParents}]\n  ${action === 'add' ? cLabels.proposedLabel : cLabels.disconnectLabel} "${c.parentName}" (${cLabels.cooccurrenceLabel} ${(c.ratio * 100).toFixed(0)}%)`;
        })
        .join('\n\n---\n\n');

      const field = action === 'add' ? 'addParents' : 'removeParents';
      const userPrompt = `${payload}\n\n${prompts.connectionsJsonNote(field)}`;

      try {
        const response = await client.chat(userPrompt, {
          instructions: systemPrompt,
          responseFormat: 'json',
        });
        const parsed = JSON.parse(cleanJsonResponse(response));
        if (Array.isArray(parsed[field])) {
          for (const c of parsed[field]) {
            if (!c.themeId || !c.parentId) continue;
            const resolvedThemeId = resolveThemeIdFromLlm(String(c.themeId), themeMap);
            const resolvedParentId = resolveThemeIdFromLlm(String(c.parentId), themeMap);
            if (!resolvedThemeId || !resolvedParentId) {
              log.warn('Theme connection could not be resolved', {
                action,
                themeId: c.themeId,
                parentId: c.parentId,
              });
              continue;
            }
            if (resolvedThemeId === resolvedParentId) continue;
            connections.push({ themeId: resolvedThemeId, parentId: resolvedParentId });
          }
        }
      } catch (e) {
        log.warn('Parent validation failed', {
          action,
          err: e instanceof Error ? e : new Error(String(e)),
        });
      }
    }

    return connections;
  }

  // --- Phase 4: Multi-assign (assign notes to additional themes) ---

  private async _analyzeMultiAssign(
    notes: Note[],
    themes: Theme[],
    noteMap: Map<string, Note>,
    themeCentroids: Map<string, number[]>,
    interiorIds: Set<string>,
    contextMd: string,
    client: ILLMClient,
    prompts: Prompts,
  ): Promise<MultiAssignment[]> {
    if (notes.length === 0 || themes.length < 2) return [];

    // Resolve anchor theme IDs (user-created themes get a lower score threshold)
    const anchorThemeIds = new Set<string>();
    if (this.configRepository) {
      const config = await this.configRepository.get();
      const anchorNames = new Set(config.baseThemes.map((bt) => bt.name));
      for (const theme of themes) {
        if (anchorNames.has(theme.name)) anchorThemeIds.add(theme.id);
      }
    }

    const candidates: MultiAssignCandidate[] = [];
    const allClassifiedNotes = [...noteMap.values()].filter((n) => n.contentVector.length > 0);
    const themeMapForAncestry = new Map(themes.map((t) => [t.id, t]));

    // Precompute per-theme topic sets (depends only on theme, not on note)
    const themeTopicsCache = new Map<string, Set<string>>(
      themes.map((t) => [t.id, new Set(t.noteIds.flatMap((id) => noteMap.get(id)?.topics ?? []))]),
    );

    for (const note of notes) {
      if (note.contentVector.length === 0) continue;
      const currentThemeIds = new Set(note.themeIds ?? []);

      // Precompute kNN once per note (depends only on note, not on theme)
      const similarIds = topKSimilarTo(note, allClassifiedNotes, 0.7, 5);
      const similarIdSet = new Set(similarIds);

      for (const theme of themes) {
        if (currentThemeIds.has(theme.id)) continue;
        // Skip themes with no signal at all (no notes, no description vector)
        if (theme.noteIds.length === 0 && !theme.descriptionVector?.length) continue;

        // Skip themes that are ancestors or descendants of the note's current themes
        const isRelatedToCurrentTheme = [...currentThemeIds].some((cid) => {
          const after = removeAncestorThemeIds([theme.id, cid], themeMapForAncestry);
          return after.length < 2;
        });
        if (isRelatedToCurrentTheme) continue;

        const themeCentroid = themeCentroids.get(theme.id);
        const rawCosine = themeCentroid ? cosine(note.contentVector, themeCentroid) : 0;
        const cosineAffinity = weightedAffinity(rawCosine, theme.id, interiorIds);

        const knnInTheme = theme.noteIds.filter((id) => similarIdSet.has(id)).length;
        const knnRatio = similarIds.length > 0 ? knnInTheme / similarIds.length : 0;

        const themeTopics = themeTopicsCache.get(theme.id)!;
        const sharedTopics = note.topics.filter((t) => themeTopics.has(t));
        const topicOverlap = note.topics.length > 0 ? sharedTopics.length / note.topics.length : 0;

        // Normalize by available signal weights when theme has no notes
        const hasNotes = theme.noteIds.length > 0;
        const score = hasNotes
          ? 0.5 * cosineAffinity + 0.3 * knnRatio + 0.2 * topicOverlap
          : cosineAffinity;

        const isAnchor = anchorThemeIds.has(theme.id);
        const minScore = isAnchor
          ? CONSOLIDATE_MULTI_ASSIGN_ANCHOR_MIN_SCORE
          : CONSOLIDATE_MULTI_ASSIGN_MIN_SCORE;

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

    // Sort: anchors first within same score band
    candidates.sort((a, b) => {
      if (a.isAnchor !== b.isAnchor) return a.isAnchor ? -1 : 1;
      return b.score - a.score;
    });
    const topCandidates = candidates.slice(0, MULTI_ASSIGN_MAX_CANDIDATES);

    const themeMap = new Map(themes.map((t) => [t.id, t]));
    const systemPrompt = buildScanSystemPrompt(
      prompts.consolidateBase,
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

  async commit(proposal: UnifiedProposal): Promise<ConsolidateCommitResult> {
    const applyResult = await applyUnifiedProposal(
      proposal,
      this.noteRepository,
      this.themeRepository,
      this.embeddingClient,
    );
    log.info('Consolidate commit applied', {
      reroutings: applyResult.redistributionsApplied,
      merges: applyResult.themesMerged,
      removals: applyResult.removalsApplied,
      addParents: applyResult.addParentsApplied,
      removeParents: applyResult.removeParentsApplied,
      multiAssigns: applyResult.multiAssignmentsApplied,
      skipped: applyResult.skipped,
    });
    return {
      reroutingsApplied: applyResult.redistributionsApplied,
      mergesApplied: applyResult.themesMerged,
      removalsApplied: applyResult.removalsApplied,
      addParentsApplied: applyResult.addParentsApplied,
      removeParentsApplied: applyResult.removeParentsApplied,
      multiAssignmentsApplied: applyResult.multiAssignmentsApplied,
      skipped: applyResult.skipped,
    };
  }
}
