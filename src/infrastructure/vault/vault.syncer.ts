import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, parse as parsePath } from 'node:path';
import type { IUserConfigRepository } from '../../domain/config/config.types';
import type { INoteRepository, Note } from '../../domain/note/note.entity';
import type { IScanProposalStore } from '../../domain/scan/scan.state';
import type { ScanType } from '../../domain/scan/scan.types';
import type { IThemeRepository, Theme } from '../../domain/theme/theme.entity';
import {
  GRAPH_TOP_K,
  topKSimilarBySummary,
  VAULT_GRAPH_THRESHOLD,
} from '../../domain/vector/vector.utils';
import { logger } from '../logger';

const log = logger.child('VaultSyncer');

// ── Name sanitizer ─────────────────────────────────────────────────────────────

const ILLEGAL = new Set(['/', ':', '?', '*', '|', '"', '<', '>', '\\']);

export function sanitizeFilename(name: string): string {
  let out = '';
  for (const ch of name) {
    if (ch === '/') out += '-';
    else if (!ILLEGAL.has(ch)) out += ch;
  }
  return out.slice(0, 200);
}

export function buildNameMap(items: { id: string; name: string }[]): Map<string, string> {
  const result = new Map<string, string>();
  const seen = new Map<string, number>();
  for (const item of items) {
    const base = sanitizeFilename(item.name) || `item-${item.id.slice(0, 8)}`;
    if (!seen.has(base)) {
      seen.set(base, 1);
      result.set(item.id, base);
    } else {
      const count = seen.get(base)! + 1;
      seen.set(base, count);
      result.set(item.id, `${base}-${count}`);
    }
  }
  return result;
}

// ── Depth map ──────────────────────────────────────────────────────────────────

export function buildDepthMap(themes: Theme[]): Map<string, number> {
  const parentMap = new Map(themes.map((t) => [t.id, t.parentIds]));
  const cache = new Map<string, number>();

  function depth(id: string): number {
    if (cache.has(id)) return cache.get(id)!;
    cache.set(id, 999); // cycle guard
    const parents = parentMap.get(id) ?? [];
    const validParents = parents.filter((p) => parentMap.has(p));
    const d = validParents.length === 0 ? 0 : Math.min(...validParents.map((p) => depth(p) + 1));
    const safeD =
      d >= 999
        ? (console.warn(`[buildDepthMap] cycle detected at node ${id}, clamping depth to 0`), 0)
        : d;
    cache.set(id, safeD);
    return safeD;
  }

  for (const t of themes) depth(t.id);
  return cache;
}

// ── Related-links frontmatter injection ────────────────────────────────────────

/**
 * Injects (or replaces) a `related:` YAML frontmatter field with wikilinks.
 * Passing an empty array removes the field. Original note body is never touched.
 */
export function injectRelatedLinks(content: string, relatedWikilinks: string[]): string {
  let fmLines: string[] = [];
  let body = content;

  if (content.startsWith('---\n')) {
    const closeIdx = content.indexOf('\n---\n', 4);
    if (closeIdx !== -1) {
      fmLines = content.slice(4, closeIdx).split('\n');
      body = content.slice(closeIdx + 5);
    }
  }

  // Strip existing related: block (field + indented continuation lines)
  const kept: string[] = [];
  let skipping = false;
  for (const line of fmLines) {
    if (line.startsWith('related:')) {
      skipping = true;
      continue;
    }
    if (skipping && (line.startsWith('  ') || line.startsWith('\t'))) continue;
    skipping = false;
    kept.push(line);
  }

  if (relatedWikilinks.length > 0) {
    kept.push('related:');
    for (const link of relatedWikilinks) kept.push(`  - "${link}"`);
  }

  if (kept.length === 0) return body;

  const sep = fmLines.length > 0 ? '' : '\n';
  return `---\n${kept.join('\n')}\n---\n${sep}${body}`;
}

// ── Renderers ──────────────────────────────────────────────────────────────────

export function renderThemeMd(
  theme: Theme,
  depth: number,
  childNames: string[],
  themeNameMap: Map<string, string>,
  noteNameMap: Map<string, string>,
): string {
  const parentLinks = theme.parentIds
    .filter((id) => themeNameMap.has(id))
    .map((id) => `[[${themeNameMap.get(id)}]]`)
    .join(' ');
  const childLinks = childNames.map((name) => `[[${name}]]`).join(' ');
  const noteLines = theme.noteIds
    .filter((id) => noteNameMap.has(id))
    .map((id) => `- [[Source/${noteNameMap.get(id)}]]`)
    .join('\n');

  const tags = ['theme'];
  if (depth === 0) tags.push('root');
  if (childNames.length === 0) tags.push('leaf');
  if (theme.parentIds.length > 1) tags.push('multiparent');
  if (theme.noteIds.length > 10) tags.push('large');
  if (theme.noteIds.length === 0) tags.push('empty');

  const parts: string[] = [
    `---\ndepth: ${depth}\nnotes: ${theme.noteIds.length}\ntags: [${tags.join(', ')}]\n---`,
    `# ${theme.name}`,
    '',
  ];
  if (parentLinks) parts.push(`**Parents:** ${parentLinks}`);
  if (childLinks) parts.push(`**Children:** ${childLinks}`);
  if (noteLines) parts.push(`\n## Notes (${theme.noteIds.length})\n${noteLines}`);

  return parts.join('\n') + '\n';
}

export function renderDashboardMd(
  notes: Note[],
  themes: Theme[],
  classifyCommits: number,
  organizeCommits: number,
  prevThemeIds?: Set<string>,
  prevThemeNames?: Map<string, string>,
): string {
  const now = new Date().toLocaleTimeString('pt-BR', { hour12: false });

  const counts = { pending: 0, processed: 0, scanned: 0, organized: 0 };
  for (const n of notes) {
    if (n.status in counts) (counts as Record<string, number>)[n.status]++;
  }

  const depthMap = buildDepthMap(themes);
  const childrenMap = new Map(themes.map((t) => [t.id, [] as string[]]));
  for (const t of themes) {
    for (const pid of t.parentIds) {
      childrenMap.get(pid)?.push(t.id);
    }
  }

  const roots = themes.filter((t) => t.parentIds.length === 0).map((t) => t.name);
  const leaves = themes
    .filter((t) => (childrenMap.get(t.id)?.length ?? 0) === 0)
    .map((t) => t.name);
  const depths = [...depthMap.values()];
  const maxDepth = depths.length > 0 ? Math.max(...depths) : 0;
  const avgDepth = depths.length > 0 ? depths.reduce((a, b) => a + b, 0) / depths.length : 0;

  const themeById = new Map(themes.map((t) => [t.id, t]));
  const multiParent = themes
    .filter((t) => t.parentIds.length > 1)
    .map((t) => `${t.name} → ${t.parentIds.map((p) => themeById.get(p)?.name ?? p).join(', ')}`);

  const notesWithTheme = notes.filter((n) => (n.themeIds?.length ?? 0) > 0).length;
  const notesWithout = notes.length - notesWithTheme;
  const multiAssigned = notes.filter((n) => (n.themeIds?.length ?? 0) > 1).length;
  const noteCounts = themes.map((t) => t.noteIds.length);
  const avgNpt =
    noteCounts.length > 0 ? noteCounts.reduce((a, b) => a + b, 0) / noteCounts.length : 0;
  const sorted = [...noteCounts].sort((a, b) => a - b);
  const medianNpt = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)]! : 0;

  const emptyThemes = themes.filter((t) => t.noteIds.length === 0).map((t) => t.name);
  const largeThemes = themes
    .filter((t) => t.noteIds.length > 10)
    .map((t) => `${t.name}(${t.noteIds.length})`);

  const deltaLines: string[] = [];
  if (prevThemeIds) {
    const currIds = new Set(themes.map((t) => t.id));
    const themeNames = new Map(themes.map((t) => [t.id, t.name]));
    for (const id of currIds) {
      if (!prevThemeIds.has(id)) deltaLines.push(`+ theme created: "${themeNames.get(id)}"`);
    }
    for (const id of prevThemeIds) {
      if (!currIds.has(id)) deltaLines.push(`✕ theme removed: "${prevThemeNames?.get(id) ?? id}"`);
    }
  }
  if (deltaLines.length === 0) deltaLines.push('(no changes)');

  const multiParentStr = multiParent.length > 0 ? `   (${multiParent.join(', ')})` : '';
  const emptyStr = emptyThemes.length > 0 ? `  → ${emptyThemes.join(', ')}` : '';
  const largeStr = largeThemes.length > 0 ? `  → ${largeThemes.join(', ')}` : '';

  return `# Dashboard — ${now}

## Pipeline
pending: ${counts.pending}  processed: ${counts.processed}  scanned: ${counts.scanned}  organized: ${counts.organized}
classify commits: ${classifyCommits}  organize commits: ${organizeCommits}

## Theme Graph
themes total: ${themes.length}    roots: ${roots.length}    leaves: ${leaves.length}
max depth: ${maxDepth}    avg depth: ${avgDepth.toFixed(1)}
multi-parent: ${multiParent.length}${multiParentStr}

## Note Coverage
notes with theme: ${notesWithTheme} / ${notes.length}    no theme: ${notesWithout}
multi-assigned: ${multiAssigned}    (notes in 2+ themes)
avg notes/theme: ${avgNpt.toFixed(1)}    median: ${medianNpt}

## Theme Health
empty (0 notes): ${emptyThemes.length}${emptyStr}
large (>10 notes): ${largeThemes.length}${largeStr}

## Δ Last round
${deltaLines.join('\n')}
`;
}

// ── Vault I/O ──────────────────────────────────────────────────────────────────

function fileHash(content: string): string {
  return createHash('md5').update(content).digest('hex');
}

async function syncFiles(
  vaultPath: string,
  files: Map<string, string>,
): Promise<{ written: number; removed: number }> {
  await mkdir(join(vaultPath, 'Themes'), { recursive: true });

  let written = 0;
  let removed = 0;

  for (const [relPath, content] of files) {
    const dest = join(vaultPath, relPath);
    await mkdir(dirname(dest), { recursive: true });
    let existing = '';
    try {
      existing = await readFile(dest, 'utf-8');
    } catch {
      // file doesn't exist yet
    }
    if (fileHash(existing) !== fileHash(content)) {
      await writeFile(dest, content, 'utf-8');
      written++;
    }
  }

  for (const subdir of ['Themes'] as const) {
    const dir = join(vaultPath, subdir);
    try {
      const entries = await readdir(dir);
      for (const entry of entries) {
        if (entry.endsWith('.md') && !files.has(`${subdir}/${entry}`)) {
          await unlink(join(dir, entry));
          removed++;
        }
      }
    } catch {
      // dir doesn't exist yet, nothing to remove
    }
  }

  return { written, removed };
}

async function setupObsidianConfig(vaultPath: string): Promise<void> {
  const obsidianDir = join(vaultPath, '.obsidian');
  await mkdir(obsidianDir, { recursive: true });
  const graphJson = join(obsidianDir, 'graph.json');
  let existing: Record<string, unknown> | null = null;
  try {
    existing = JSON.parse(await readFile(graphJson, 'utf-8')) as Record<string, unknown>;
  } catch {
    // file doesn't exist — write defaults
  }
  if (existing !== null) return; // preserve user customizations
  const defaults: Record<string, unknown> = {
    colorGroups: [
      { query: 'tag:#large', color: { a: 1, rgb: 0xe74c3c } },
      { query: 'tag:#theme', color: { a: 1, rgb: 0x3498db } },
      { query: 'tag:#orphan', color: { a: 1, rgb: 0xe67e22 } },
      { query: 'tag:#note', color: { a: 1, rgb: 0x7f8c8d } },
    ],
  };
  await writeFile(graphJson, JSON.stringify(defaults, null, 2), 'utf-8');
}

// ── VaultSyncer class ──────────────────────────────────────────────────────────

export class VaultSyncer {
  private prevThemeIds: Set<string> | undefined;
  private prevThemeNames: Map<string, string> | undefined;

  constructor(
    private noteRepo: INoteRepository,
    private themeRepo: IThemeRepository,
    private userConfigRepo: IUserConfigRepository,
    private scanProposalStore?: IScanProposalStore,
  ) {}

  async sync(): Promise<void> {
    const config = await this.userConfigRepo.get();
    if (!config.vaultPath) return;

    const [notes, themes] = await Promise.all([this.noteRepo.findAll(), this.themeRepo.findAll()]);

    const scanState = await this._getScanState();

    const themeNameMap = buildNameMap(themes.map((t) => ({ id: t.id, name: t.name })));
    const noteNameMap = buildNameMap(notes.map((n) => ({ id: n.id, name: n.title })));

    const childrenMap = new Map(themes.map((t) => [t.id, [] as string[]]));
    for (const t of themes) {
      for (const pid of t.parentIds) {
        childrenMap.get(pid)?.push(themeNameMap.get(t.id) ?? t.name);
      }
    }

    const depthMap = buildDepthMap(themes);
    const files = new Map<string, string>();

    for (const theme of themes) {
      const name = themeNameMap.get(theme.id)!;
      files.set(
        `Themes/${name}.md`,
        renderThemeMd(
          theme,
          depthMap.get(theme.id) ?? 0,
          childrenMap.get(theme.id) ?? [],
          themeNameMap,
          noteNameMap,
        ),
      );
    }

    files.set(
      '_Dashboard.md',
      renderDashboardMd(
        notes,
        themes,
        scanState.classifyCommits,
        scanState.organizeCommits,
        this.prevThemeIds,
        this.prevThemeNames,
      ),
    );

    const linksEnabled = config.vaultLinks !== false;
    const vaultLinks = linksEnabled
      ? topKSimilarBySummary(notes, VAULT_GRAPH_THRESHOLD, GRAPH_TOP_K)
      : new Map<string, string[]>();

    await setupObsidianConfig(config.vaultPath);
    await syncFiles(config.vaultPath, files);
    await this._syncSourceNotes(config.vaultPath, notes, noteNameMap, vaultLinks);

    this.prevThemeIds = new Set(themes.map((t) => t.id));
    this.prevThemeNames = new Map(themes.map((t) => [t.id, t.name]));
  }

  private async _syncSourceNotes(
    vaultPath: string,
    notes: Note[],
    noteNameMap: Map<string, string>,
    vaultLinks: Map<string, string[]>,
  ): Promise<void> {
    const noteVaultName = (n: Note): string =>
      n.sourceFile ? parsePath(n.sourceFile).name : (noteNameMap.get(n.id) ?? n.id);

    const noteById = new Map(notes.map((n) => [n.id, n]));

    for (const note of notes) {
      if (!note.sourceFile) continue;

      const filePath = join(vaultPath, 'Source', note.sourceFile);
      let existing: string;
      try {
        existing = await readFile(filePath, 'utf-8');
      } catch {
        continue;
      }

      const wikilinks = (vaultLinks.get(note.id) ?? [])
        .map((id) => noteById.get(id))
        .filter((n): n is Note => !!n)
        .map((n) => `[[Source/${noteVaultName(n)}]]`);

      const updated = injectRelatedLinks(existing, wikilinks);
      if (updated !== existing) await writeFile(filePath, updated, 'utf-8');
    }
  }

  async saveProposal(type: ScanType, proposal: unknown): Promise<string | null> {
    const config = await this.userConfigRepo.get();
    if (!config.vaultPath) return null;

    const dir = join(config.vaultPath, 'Proposals');
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, `${type}-proposal.json`);
    await writeFile(filePath, JSON.stringify(proposal, null, 2), 'utf-8');
    log.info('Proposal saved to vault', { file: filePath });
    return filePath;
  }

  private async _getScanState(): Promise<{ classifyCommits: number; organizeCommits: number }> {
    if (!this.scanProposalStore) return { classifyCommits: 0, organizeCommits: 0 };
    const state = await this.scanProposalStore.getScanState();
    return {
      classifyCommits: state.classifyCommitCount,
      organizeCommits: state.organizeCommitCount,
    };
  }
}
