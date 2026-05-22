import type { Theme } from '../../../domain/theme/theme.entity';

/**
 * Converts LLM output (existing theme UUID or exact name) into the canonical id.
 * A name duplicated across more than one theme returns null (ambiguous).
 */
export function resolveThemeIdFromLlm(raw: string, themeById: Map<string, Theme>): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (themeById.has(s)) return s;
  const matches = [...themeById.values()].filter((t) => t.name === s);
  if (matches.length === 1) return matches[0]?.id ?? null;
  return null;
}
