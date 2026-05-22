import type { ILLMClient } from '../../../domain/llm/llm.types';
import type { SplitLabels } from '../../../domain/llm/prompts';
import type { Note } from '../../../domain/note/note.entity';
import type { ThemeSplit } from '../../../domain/scan/scan.types';
import type { Theme } from '../../../domain/theme/theme.entity';
import {
  buildDepthMap,
  clusterThresholdForDepth,
  detectThemeClusters,
  minNotesForDepth,
} from '../../../domain/vector/vector.utils';
import { logger } from '../../../infrastructure/logger';

const log = logger.child('Splits');

import type { ThemeSplitCandidate } from '../../../domain/vector/vector.utils';
import { buildScanSystemPrompt, cleanJsonResponse } from './scan.shared';

export const SPLIT_MIN_CLUSTER = 2;
const LLM_FALLBACK_MIN_NOTES = 10;

/** Top-N most frequent topics across notes in a theme. */
export function computeTopTopics(notes: Note[], topN: number): { topic: string; count: number }[] {
  const freq = new Map<string, number>();
  for (const n of notes) {
    for (const t of n.topics) {
      freq.set(t, (freq.get(t) ?? 0) + 1);
    }
  }
  return [...freq.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([topic, count]) => ({ topic, count }));
}

/** Notes shared between this theme and other themes (cross-theme overlap). */
export function computeCrossThemeOverlap(
  theme: Theme,
  themeNotes: Note[],
  allThemes: Theme[],
): { themeName: string; count: number }[] {
  const noteIds = new Set(themeNotes.map((n) => n.id));
  const overlaps: { themeName: string; count: number }[] = [];
  for (const other of allThemes) {
    if (other.id === theme.id) continue;
    const count = other.noteIds.filter((id) => noteIds.has(id)).length;
    if (count >= 2) overlaps.push({ themeName: other.name, count });
  }
  return overlaps.sort((a, b) => b.count - a.count).slice(0, 5);
}

export async function analyzeSplits(
  themes: Theme[],
  noteMap: Map<string, Note>,
  llmClient: ILLMClient,
  baseSystem: string,
  contextMd: string,
  splitLabels: SplitLabels,
  splitInstruction: string,
  splitDepthCaution: (depth: number) => string,
  splitResidualNote: (count: number) => string,
  splitFallbackInstruction: string,
  splitJsonInstruction: string,
  styleInstruction?: string,
  minNotesOverride?: number, // consolidate pode passar minNotes diferente
): Promise<ThemeSplit[]> {
  const depthMap = buildDepthMap(themes);
  const allSplits: ThemeSplit[] = [];

  // Phase 1: Detect vector clusters for all depths (threshold increases with depth)
  const vectorCandidates: ThemeSplitCandidate[] = [];
  const vectorHandledIds = new Set<string>();
  for (const theme of themes) {
    const depth = depthMap.get(theme.id) ?? 0;
    const threshold = clusterThresholdForDepth(depth);
    const minNotes = minNotesForDepth(depth);
    const candidate = detectThemeClusters(theme, noteMap, minNotes, SPLIT_MIN_CLUSTER, threshold);
    if (candidate) {
      vectorCandidates.push(candidate);
      vectorHandledIds.add(theme.id);
    }
  }

  // LLM names the clusters detected by vectors
  if (vectorCandidates.length > 0) {
    const systemPrompt = buildScanSystemPrompt(
      baseSystem,
      splitInstruction,
      contextMd,
      styleInstruction,
    );

    for (const candidate of vectorCandidates) {
      const theme = themes.find((t) => t.id === candidate.themeId)!;
      const depth = depthMap.get(theme.id) ?? 0;
      const siblings = themes
        .filter(
          (t) => t.id !== theme.id && t.parentIds.some((pid) => theme.parentIds.includes(pid)),
        )
        .map((t) => t.name)
        .join(', ');
      const existingChildren = themes
        .filter((t) => t.parentIds.includes(theme.id))
        .map((t) => t.name)
        .join(', ');

      const clustersPayload = candidate.clusters
        .map((cluster, i) => {
          const noteLines = cluster
            .map(
              (n) =>
                `  - [${n.id}] "${n.title}" | ${splitLabels.topicsLabel} ${n.topics.join(', ') || splitLabels.noTopicsLabel}`,
            )
            .join('\n');
          return `${splitLabels.clusterLabel(i, cluster.length)}\n${noteLines}`;
        })
        .join('\n\n');

      // Enrich: top topics + cross-theme overlap
      const themeNotes = theme.noteIds.map((id) => noteMap.get(id)).filter((n): n is Note => !!n);
      const topTopics = computeTopTopics(themeNotes, 5);
      const crossTheme = computeCrossThemeOverlap(theme, themeNotes, themes);

      const depthInstruction = splitDepthCaution(depth);

      const userPrompt = `Theme: "${theme.name}"${theme.description ? ` — ${theme.description}` : ''} (${theme.noteIds.length} notes total, ${candidate.clusters.length} clusters detected, depth ${depth})
${existingChildren ? `${splitLabels.existingSubthemesLabel} ${existingChildren}\n` : ''}${siblings ? `${splitLabels.siblingsLabel} ${siblings}\n` : ''}
${topTopics.length > 0 ? `${splitLabels.topFreqTopicsLabel} ${topTopics.map((t) => `${t.topic} (${t.count}x)`).join(', ')}\n` : ''}${crossTheme.length > 0 ? `${splitLabels.overlapLabel} ${crossTheme.map((c) => `${c.themeName} (${c.count} shared notes)`).join(', ')}\n` : ''}${depthInstruction}
${clustersPayload}
${candidate.residual.length > 0 ? `\n${splitResidualNote(candidate.residual.length)}` : ''}

${splitJsonInstruction}`;

      try {
        const response = await llmClient.chat(userPrompt, {
          instructions: systemPrompt,
          responseFormat: 'json',
        });
        const parsed = JSON.parse(cleanJsonResponse(response));
        if (Array.isArray(parsed.splits)) {
          for (const s of parsed.splits) {
            if (s.name && Array.isArray(s.noteIds) && s.noteIds.length >= SPLIT_MIN_CLUSTER) {
              allSplits.push({
                parentThemeId: theme.id,
                newSubTheme: {
                  name: String(s.name),
                  ...(s.description ? { description: String(s.description) } : {}),
                },
                noteIds: s.noteIds.map(String),
              });
            }
          }
        }
      } catch (e) {
        log.warn('Vector split failed', {
          theme: theme.name,
          depth,
          err: e instanceof Error ? e : new Error(String(e)),
        });
      }
    }
  }

  // Phase 2: LLM fallback for large themes where vectors found no clusters
  const fallbackMinNotes = minNotesOverride ?? LLM_FALLBACK_MIN_NOTES;
  const llmFallbackThemes = themes.filter((t) => {
    if (vectorHandledIds.has(t.id)) return false;
    const noteCount = t.noteIds.filter((id) => noteMap.has(id)).length;
    return noteCount >= fallbackMinNotes;
  });

  if (llmFallbackThemes.length > 0) {
    const systemPrompt = buildScanSystemPrompt(
      baseSystem,
      splitFallbackInstruction,
      contextMd,
      styleInstruction,
    );

    for (const theme of llmFallbackThemes) {
      const depth = depthMap.get(theme.id) ?? 0;
      const themeNotes = theme.noteIds.map((id) => noteMap.get(id)).filter((n): n is Note => !!n);
      const siblings = themes
        .filter(
          (t) => t.id !== theme.id && t.parentIds.some((pid) => theme.parentIds.includes(pid)),
        )
        .map((t) => t.name)
        .join(', ');
      const existingChildren = themes
        .filter((t) => t.parentIds.includes(theme.id))
        .map((t) => t.name)
        .join(', ');

      const notesPayload = themeNotes
        .map(
          (n) =>
            `- [${n.id}] "${n.title}" | Summary: ${n.summary || '(none)'} | ${splitLabels.topicsLabel} ${n.topics.join(', ') || splitLabels.noTopicsLabel}`,
        )
        .join('\n');

      const topTopics = computeTopTopics(themeNotes, 5);
      const crossTheme = computeCrossThemeOverlap(theme, themeNotes, themes);
      const depthInstruction = splitDepthCaution(depth);

      const userPrompt = `Theme: "${theme.name}"${theme.description ? ` — ${theme.description}` : ''} (${themeNotes.length} notes, depth ${depth}, no vector clusters detected)
${existingChildren ? `${splitLabels.existingSubthemesLabel} ${existingChildren}\n` : ''}${siblings ? `${splitLabels.siblingsLabel} ${siblings}\n` : ''}
${topTopics.length > 0 ? `${splitLabels.topFreqTopicsLabel} ${topTopics.map((t) => `${t.topic} (${t.count}x)`).join(', ')}\n` : ''}${crossTheme.length > 0 ? `${splitLabels.overlapLabel} ${crossTheme.map((c) => `${c.themeName} (${c.count} shared notes)`).join(', ')}\n` : ''}${depthInstruction}
Notes:
${notesPayload}

${splitJsonInstruction}`;

      try {
        const response = await llmClient.chat(userPrompt, {
          instructions: systemPrompt,
          responseFormat: 'json',
        });
        const parsed = JSON.parse(cleanJsonResponse(response));
        if (Array.isArray(parsed.splits)) {
          for (const s of parsed.splits) {
            if (s.name && Array.isArray(s.noteIds) && s.noteIds.length >= SPLIT_MIN_CLUSTER) {
              allSplits.push({
                parentThemeId: theme.id,
                newSubTheme: {
                  name: String(s.name),
                  ...(s.description ? { description: String(s.description) } : {}),
                },
                noteIds: s.noteIds.map(String),
              });
            }
          }
        }
      } catch (e) {
        log.warn('LLM fallback split failed', {
          theme: theme.name,
          depth,
          err: e instanceof Error ? e : new Error(String(e)),
        });
      }
    }
  }

  return allSplits;
}
