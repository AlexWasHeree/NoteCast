import type { Note } from './note.entity';

/** Maximum number of content characters used for the graph embedding when no summary exists. */
export const GRAPH_EMBED_CONTENT_FALLBACK_MAX = 2000;

/**
 * Text used for the main embedding (classify, organize, consolidate, centroids).
 * Full content + YAKE topics to preserve lexical precision.
 */
export function buildMainEmbedText(note: Pick<Note, 'title' | 'content' | 'topics'>): string {
  const topicLine =
    note.topics && note.topics.length > 0 ? `\nTopics: ${note.topics.join(', ')}` : '';
  return `${note.title}\n${note.content}${topicLine}`.trim();
}

/**
 * Text used only for the semantic graph embedding (neighbors / reroute).
 * Summary + topics; falls back to a partial content snippet if the summary is empty.
 */
export function buildGraphEmbedText(
  note: Pick<Note, 'title' | 'content' | 'summary' | 'topics'>,
): string {
  const topicLine =
    note.topics && note.topics.length > 0 ? `\nTopics: ${note.topics.join(', ')}` : '';
  const sum = (note.summary ?? '').trim();
  if (sum) {
    return `${note.title}\n${sum}${topicLine}`.trim();
  }
  const snippet = note.content.slice(0, GRAPH_EMBED_CONTENT_FALLBACK_MAX);
  return `${note.title}\n${snippet}${topicLine}`.trim();
}
