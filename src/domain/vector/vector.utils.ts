// src/domain/vector.utils.ts
import type { Note } from '../note/note.entity';
import type { Theme } from '../theme/theme.entity';

export const CLUSTER_THRESHOLD = 0.6;
export const INTRA_THEME_CLUSTER_THRESHOLD = 0.72;
export const INTRA_DEPTH_INCREMENT = 0.07;

export const GRAPH_THRESHOLD = 0.74;
export const GRAPH_TOP_K = 6;
export const VAULT_GRAPH_THRESHOLD = 0.85;

export function clusterThresholdForDepth(depth: number): number {
  return Math.min(INTRA_THEME_CLUSTER_THRESHOLD + depth * INTRA_DEPTH_INCREMENT, 0.95);
}

export function minNotesForDepth(depth: number): number {
  return Math.min(4 + depth, 10);
}

export function buildDepthMap(themes: { id: string; parentIds: string[] }[]): Map<string, number> {
  const parentsMap = new Map(themes.map((t) => [t.id, t.parentIds]));
  const cache = new Map<string, number>();

  function depth(id: string): number {
    if (cache.has(id)) return cache.get(id)!;
    cache.set(id, Infinity);
    const pids = parentsMap.get(id) ?? [];
    const d = pids.length === 0 ? 0 : Math.min(...pids.map((pid) => depth(pid) + 1));
    cache.set(id, d === Infinity ? 0 : d);
    return cache.get(id)!;
  }

  for (const t of themes) depth(t.id);
  return cache;
}

export function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let dot = 0,
    magA = 0,
    magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    magA += a[i]! * a[i]!;
    magB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

export function centroid(vectors: number[][]): number[] {
  if (vectors.length === 0) return [];
  const dims = vectors[0]!.length;
  const sum = new Array(dims).fill(0) as number[];
  for (const v of vectors) for (let i = 0; i < dims; i++) sum[i]! += v[i]!;
  return sum.map((x) => x / vectors.length);
}

export function clusterByCosine(notes: Note[], threshold = CLUSTER_THRESHOLD): Note[][] {
  const vectorized = notes.filter((n) => n.contentVector.length > 0);
  const clusters: Note[][] = [];
  const centroids: number[][] = [];

  for (const note of vectorized) {
    let assigned = false;
    for (let i = 0; i < clusters.length; i++) {
      if (cosine(centroids[i]!, note.contentVector) >= threshold) {
        clusters[i]!.push(note);
        centroids[i] = centroid(clusters[i]!.map((n) => n.contentVector));
        assigned = true;
        break;
      }
    }
    if (!assigned) {
      clusters.push([note]);
      centroids.push([...note.contentVector]);
    }
  }
  return clusters;
}

export interface ThemeSplitCandidate {
  themeId: string;
  clusters: Note[][];
  residual: Note[];
}

export function detectThemeClusters(
  theme: Theme,
  noteMap: Map<string, Note>,
  minNotes: number,
  minClusterSize: number,
  clusterThreshold = INTRA_THEME_CLUSTER_THRESHOLD,
): ThemeSplitCandidate | null {
  const themeNotes = theme.noteIds
    .map((id) => noteMap.get(id))
    .filter((n): n is Note => !!n && n.contentVector.length > 0);

  if (themeNotes.length < minNotes) return null;

  const clusters = clusterByCosine(themeNotes, clusterThreshold);
  const validClusters = clusters.filter((c) => c.length >= minClusterSize);

  if (validClusters.length === 0) return null;

  const clusterNoteIds = new Set(validClusters.flatMap((c) => c.map((n) => n.id)));
  const residual = themeNotes.filter((n) => !clusterNoteIds.has(n.id));

  if (validClusters.length === 1 && residual.length === 0) return null;

  return { themeId: theme.id, clusters: validClusters, residual };
}

export function topKSimilarTo(
  target: Note,
  corpus: Note[],
  threshold: number,
  k: number,
): string[] {
  if (target.contentVector.length === 0) return [];
  const similarities: { id: string; score: number }[] = [];
  for (const note of corpus) {
    if (note.id === target.id || note.contentVector.length === 0) continue;
    const score = cosine(target.contentVector, note.contentVector);
    if (score >= threshold) similarities.push({ id: note.id, score });
  }
  similarities.sort((a, b) => b.score - a.score);
  return similarities.slice(0, k).map((x) => x.id);
}

export function topKSimilar(notes: Note[], threshold: number, k: number): Map<string, string[]> {
  const vectorized = notes.filter((n) => n.contentVector.length > 0);
  const result = new Map<string, string[]>();

  for (const note of vectorized) {
    const similarities: { id: string; score: number }[] = [];
    for (const other of vectorized) {
      if (other.id === note.id) continue;
      const score = cosine(note.contentVector, other.contentVector);
      if (score >= threshold) similarities.push({ id: other.id, score });
    }
    similarities.sort((a, b) => b.score - a.score);
    result.set(
      note.id,
      similarities.slice(0, k).map((x) => x.id),
    );
  }
  return result;
}

/** Use summaryVector when present, fall back to contentVector (notes predating summaryVector). */
export function effectiveSummaryVector(note: {
  summaryVector: number[];
  contentVector: number[];
}): number[] {
  if (note.summaryVector && note.summaryVector.length > 0) return note.summaryVector;
  return note.contentVector;
}

export function topKSimilarToSummary(
  target: { id: string; summaryVector: number[]; contentVector: number[] },
  corpus: Array<{ id: string; summaryVector: number[]; contentVector: number[] }>,
  threshold: number,
  k: number,
): string[] {
  const tv = effectiveSummaryVector(target);
  if (tv.length === 0) return [];
  const similarities: { id: string; score: number }[] = [];
  for (const note of corpus) {
    if (note.id === target.id) continue;
    const nv = effectiveSummaryVector(note);
    if (nv.length === 0) continue;
    const score = cosine(tv, nv);
    if (score >= threshold) similarities.push({ id: note.id, score });
  }
  similarities.sort((a, b) => b.score - a.score);
  return similarities.slice(0, k).map((x) => x.id);
}

export function topKSimilarBySummary(
  notes: Note[],
  threshold: number,
  k: number,
): Map<string, string[]> {
  const vectorized = notes.filter((n) => effectiveSummaryVector(n).length > 0);
  const result = new Map<string, string[]>();
  for (const note of vectorized) {
    const similarities: { id: string; score: number }[] = [];
    const v = effectiveSummaryVector(note);
    for (const other of vectorized) {
      if (other.id === note.id) continue;
      const ov = effectiveSummaryVector(other);
      const score = cosine(v, ov);
      if (score >= threshold) similarities.push({ id: other.id, score });
    }
    similarities.sort((a, b) => b.score - a.score);
    result.set(
      note.id,
      similarities.slice(0, k).map((x) => x.id),
    );
  }
  return result;
}
