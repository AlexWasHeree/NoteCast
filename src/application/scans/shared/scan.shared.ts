import type { ILLMClient } from '../../../domain/llm/llm.types';
import type { MultiAssignLabels } from '../../../domain/llm/prompts';
import type { Note } from '../../../domain/note/note.entity';
import type { MultiAssignment } from '../../../domain/scan/scan.types';
import type { Theme } from '../../../domain/theme/theme.entity';
import { centroid } from '../../../domain/vector/vector.utils';
import { logger } from '../../../infrastructure/logger';
import { resolveThemeIdFromLlm } from './llm.theme.ref';

const log = logger.child('Scan');

export function cleanJsonResponse(raw: string): string {
  return raw
    .replace(/```json?\s*/g, '')
    .replace(/```\s*$/g, '')
    .trim();
}

// Blends note-centroid (0.7) + descriptionVector (0.3). Falls back to either alone.
export function computeThemeCentroids(
  themes: Theme[],
  noteMap: Map<string, Note>,
): Map<string, number[]> {
  const result = new Map<string, number[]>();
  for (const theme of themes) {
    const vectors = theme.noteIds
      .map((id) => noteMap.get(id)?.contentVector ?? [])
      .filter((v) => v.length > 0);
    const notesCent = vectors.length > 0 ? centroid(vectors) : null;
    const descVec = theme.descriptionVector?.length ? theme.descriptionVector : null;
    if (notesCent && descVec) {
      result.set(
        theme.id,
        notesCent.map((v, i) => 0.7 * v + 0.3 * descVec[i]!),
      );
    } else if (notesCent) {
      result.set(theme.id, notesCent);
    } else if (descVec) {
      result.set(theme.id, descVec);
    }
  }
  return result;
}

/**
 * Interior node weight: penalizes cosine affinity for themes that have children.
 * Generic parent centroids sit in the "center" of embedding space and score artificially
 * high against diverse notes. This weight corrects that bias so leaf themes compete fairly.
 */
export const INTERIOR_NODE_WEIGHT = 0.9;

/** Pre-compute set of theme IDs that have at least one child. */
export function computeInteriorNodeIds(themes: Theme[]): Set<string> {
  const ids = new Set<string>();
  for (const t of themes) {
    for (const pid of t.parentIds) ids.add(pid);
  }
  return ids;
}

/** Apply interior-node weight to a cosine score when the theme has children. */
export function weightedAffinity(score: number, themeId: string, interiorIds: Set<string>): number {
  return interiorIds.has(themeId) ? score * INTERIOR_NODE_WEIGHT : score;
}

export function buildScanSystemPrompt(
  baseSystem: string,
  phaseInstruction: string,
  contextMd: string,
  styleInstruction?: string,
  contextLabel = 'User context:',
): string {
  const parts = [baseSystem, phaseInstruction];
  if (styleInstruction) parts.push(styleInstruction);
  if (contextMd) parts.push(`\n${contextLabel}\n${contextMd}`);
  return parts.join('\n');
}

export type MultiAssignCandidate = {
  note: Note;
  themeId: string;
  themeName: string;
  score: number;
  reason: string;
  isAnchor: boolean;
};

// Shared LLM validation for multi-assign candidates — identical in organize and consolidate
export async function llmValidateMultiAssign(
  candidates: MultiAssignCandidate[],
  themeMap: Map<string, Theme>,
  llmClient: ILLMClient,
  systemPrompt: string,
  batchSize: number,
  labels: MultiAssignLabels,
): Promise<MultiAssignment[]> {
  const results: MultiAssignment[] = [];

  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    const allowedNoteIds = new Set(batch.map((c) => c.note.id));

    const payload = batch
      .map((c) => {
        const currentThemes = (c.note.themeIds ?? [])
          .map((id) => themeMap.get(id)?.name ?? id)
          .join(', ');
        const themeLabel = c.isAnchor ? `★ "${c.themeName}"` : `"${c.themeName}"`;
        return `[ID: ${c.note.id}] "${c.note.title}" | ${labels.topicsLabel} ${c.note.topics.join(', ') || labels.noTopicsLabel}
  ${labels.currentThemesLabel} [${currentThemes}]
  ${labels.candidateLabel} ${themeLabel} (${c.reason})`;
      })
      .join('\n\n---\n\n');

    const userPrompt = `${payload}\n\n${labels.jsonInstruction}`;

    try {
      const response = await llmClient.chat(userPrompt, {
        instructions: systemPrompt,
        responseFormat: 'json',
      });
      const parsed = JSON.parse(cleanJsonResponse(response));
      if (Array.isArray(parsed.multiAssignments)) {
        for (const ma of parsed.multiAssignments) {
          if (!ma.themeId) continue;
          const resolvedThemeId = resolveThemeIdFromLlm(String(ma.themeId), themeMap);
          if (!resolvedThemeId) continue;
          const nid = typeof ma.noteId === 'string' ? ma.noteId.trim() : '';
          const noteId = nid && allowedNoteIds.has(nid) ? nid : null;
          if (noteId) results.push({ noteId, themeId: resolvedThemeId });
        }
      }
    } catch (e) {
      log.warn('Multi-assign validation failed', {
        err: e instanceof Error ? e : new Error(String(e)),
      });
    }
  }

  return results;
}
