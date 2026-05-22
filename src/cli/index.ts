import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import * as readline from 'node:readline';
import { Writable } from 'node:stream';
import { createHeadless } from '../bootstrap';
import type { INoteRepository, Note } from '../domain/note/note.entity';
import type { IThemeRepository, Theme } from '../domain/theme/theme.entity';
import { detectAvailableProviders } from '../infrastructure/llm/clients/llm.factory';
import { listStoredProviders, saveKey } from '../infrastructure/notes-auth';

export const DEFAULT_NOTES_URL = 'http://localhost:3000';

async function askLine(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<string>((resolve) =>
    rl.question(prompt, (ans) => {
      rl.close();
      resolve(ans);
    }),
  );
}

async function findNoteByQuery(query: string, noteRepository: INoteRepository): Promise<Note> {
  const all = await noteRepository.findAll();
  const lower = query.toLowerCase();
  const matches = all.filter((n) => n.title.toLowerCase().includes(lower));

  if (matches.length === 0) die(`No notes found matching: "${query}"`);

  if (matches.length === 1) return matches[0];

  process.stdout.write('Multiple notes found:\n');
  for (let i = 0; i < matches.length; i++) {
    process.stdout.write(`  ${i + 1}. [${matches[i].status}] ${matches[i].title}\n`);
  }
  const choice = await askLine(`Select (1-${matches.length}): `);
  const idx = parseInt(choice, 10) - 1;
  if (Number.isNaN(idx) || idx < 0 || idx >= matches.length) die('Invalid selection');
  return matches[idx];
}

async function findThemeByQuery(query: string, themeRepository: IThemeRepository): Promise<Theme> {
  const all = await themeRepository.findAll();
  const lower = query.toLowerCase();
  const matches = all.filter((t) => t.name.toLowerCase().includes(lower) || t.id === query);

  if (matches.length === 0) die(`No themes found matching: "${query}"`);

  if (matches.length === 1) return matches[0];

  process.stdout.write('Multiple themes found:\n');
  for (let i = 0; i < matches.length; i++) {
    process.stdout.write(`  ${i + 1}. ${matches[i].name}\n`);
  }
  const choice = await askLine(`Select (1-${matches.length}): `);
  const idx = parseInt(choice, 10) - 1;
  if (Number.isNaN(idx) || idx < 0 || idx >= matches.length) die('Invalid selection');
  return matches[idx];
}

async function enrichProposal(
  scanType: string,
  proposal: unknown,
  noteRepo: INoteRepository,
  themeRepo: IThemeRepository,
): Promise<unknown> {
  const [allNotes, allThemes] = await Promise.all([noteRepo.findAll(), themeRepo.findAll()]);
  const p = proposal as import('../domain/scan/unified.proposal').UnifiedProposal;

  const noteNames = new Map(allNotes.map((n) => [n.id, n.title]));
  for (const note of p.context?.notes ?? []) noteNames.set(note.id, note.title);

  const themeNames = new Map(allThemes.map((t) => [t.id, t.name]));
  for (const theme of p.context?.themes ?? []) themeNames.set(theme.id, theme.name);
  for (const theme of p.createThemes ?? []) {
    if (theme.id) themeNames.set(theme.id, theme.name);
  }

  const noteTitle = (id: string) => noteNames.get(id) ?? id;
  const themeName = (id: string) => themeNames.get(id) ?? id;

  return {
    context: {
      themes: p.context?.themes ?? [],
      notes: p.context?.notes ?? [],
    },
    assignments: (p.assignments ?? []).map((a) => ({
      ...a,
      _noteTitle: noteTitle(a.noteId),
      _themeName: themeName(a.themeId),
    })),
    createThemes: (p.createThemes ?? []).map((theme) => ({
      ...theme,
      _parentNames: theme.parentIds.map(themeName),
    })),
    splits: (p.splits ?? []).map((s) => ({
      ...s,
      _parentThemeName: themeName(s.parentThemeId),
      _newThemeName: themeName(s.newThemeId),
      _notesTitles: s.noteIds.map(noteTitle),
    })),
    merges: (p.merges ?? []).map((m) => ({
      ...m,
      _sourceThemeName: themeName(m.sourceThemeId),
      _targetThemeName: themeName(m.targetThemeId),
    })),
    redistributions: (p.redistributions ?? []).map((r) => ({
      ...r,
      _noteTitle: noteTitle(r.noteId),
      _fromThemeName: themeName(r.fromThemeId),
      _toThemeName: themeName(r.toThemeId),
    })),
    removals: p.removals ?? [],
    _removalsNames: (p.removals ?? []).map(themeName),
    addParents: (p.addParents ?? []).map((c) => ({
      ...c,
      _themeName: themeName(c.themeId),
      _parentName: themeName(c.parentId),
    })),
    removeParents: (p.removeParents ?? []).map((c) => ({
      ...c,
      _themeName: themeName(c.themeId),
      _parentName: themeName(c.parentId),
    })),
    multiAssignments: (p.multiAssignments ?? []).map((m) => ({
      ...m,
      _noteTitle: noteTitle(m.noteId),
      _themeName: themeName(m.themeId),
    })),
  };
}

type Headless = Awaited<ReturnType<typeof createHeadless>>;

const SCAN_TYPES = ['classify', 'organize', 'consolidate'] as const;

/** Write any pending proposals to disk and print a summary line for each. */
async function writePendingProposals(headless: Headless): Promise<void> {
  for (const scanType of SCAN_TYPES) {
    const record = await headless.scanProposalStore.getPending(scanType);
    if (!record) continue;

    const enriched = await enrichProposal(
      scanType,
      record.proposal,
      headless.noteRepository,
      headless.themeRepository,
    );
    const filePath = `./proposal-${scanType}.json`;
    writeFileSync(filePath, JSON.stringify(enriched, null, 2));
    process.stdout.write(
      `pipeline: ${scanType} ready — proposal saved to ${filePath}\nReview and run: notecast scan commit ${scanType}\n`,
    );
  }
}

/** After adding notes: trigger orchestrator, wait for pipeline, report all pending proposals. */
async function autoAdvancePipeline(headless: Headless): Promise<void> {
  await headless.scanOrchestrator.onNoteProcessed();
  await headless.scanPipeline.waitForIdle();
  await writePendingProposals(headless);
}

/** After any commit: wait for pipeline to finish next stage, report all pending proposals. */
async function advanceAfterCommit(headless: Headless): Promise<void> {
  await headless.scanPipeline.waitForIdle();
  await writePendingProposals(headless);
}

const HELP_TEXT =
  `NoteCast CLI\n\nUsage:\n` +
  `  notecast add <file>                    Create a note from a file (any text format)\n` +
  `  notecast add-batch <dir>               Create notes from all files in a dir\n` +
  `  notecast delete <query>                Delete a note by title search\n` +
  `  notecast update <query>                Edit a note's source file and reprocess\n` +
  `  notecast status                        Show pipeline status\n` +
  `  notecast scan propose <type>           Generate proposal (classify|organize|consolidate)\n` +
  `  notecast scan commit [type]            Apply proposal (auto-detects if type omitted)\n` +
  `  notecast config get                    Print current config\n` +
  `  notecast config set <key> <value>      Patch a config value\n` +
  `  notecast config set vaultPath <path>   Set Obsidian vault output folder\n` +
  `  notecast providers                     Show configured LLM providers\n` +
  `  notecast login <provider> [key]        Save API key for a provider (openai|anthropic|gemini|deepseek)\n` +
  `  notecast reset [--full]                Reset pipeline (soft: reprocess scans; full: delete all notes)\n` +
  `  notecast retry-failed                  Re-enqueue notes that failed Stage 1 processing\n` +
  `  notecast note assign <note-query> --theme <theme-query>  Assign note to theme manually\n` +
  `  notecast note unassign <note-query> --theme <theme-query>  Remove note from theme\n` +
  `  notecast theme list                    List all themes\n` +
  `  notecast theme add <name>              Create a theme (options: --parent <name-or-id>, --desc <text>)\n` +
  `  notecast theme remove <query>          Delete a theme by name search\n` +
  `  notecast theme update <query> [--name <n>] [--parent <p>] [--desc <d>]  Rename/reparent/redescribe theme\n` +
  `  notecast theme merge <source> --into <target>  Merge source theme into target\n` +
  `  notecast start                         Start HTTP server (for remote/desktop use)\n` +
  `  notecast codex-login                   Run codex login\n\n` +
  `Env: NOTES_URL=http://... to use a remote server instead of direct DB access\n`;

type ScanType = 'classify' | 'organize' | 'consolidate';

function die(msg: string): never {
  throw new Error(msg);
}

function isRemoteMode(): boolean {
  return !!process.env.NOTES_URL;
}

function resolveBaseUrl(): string {
  return process.env.NOTES_URL ?? DEFAULT_NOTES_URL;
}

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${resolveBaseUrl()}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    let msg = text;
    try {
      const j = JSON.parse(text) as { error?: string };
      if (j.error) msg = j.error;
    } catch {
      // keep raw text
    }
    throw new Error(`HTTP ${res.status}: ${msg}`);
  }

  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) return res.json() as Promise<T>;
  return res.text() as unknown as T;
}

function loadNoteFromFile(filePath: string): { title: string; content: string; basename: string } {
  if (!existsSync(filePath)) die(`File not found: ${filePath}`);

  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    die(`Cannot read file as UTF-8 text: ${filePath}`);
    throw new Error('unreachable'); // satisfy TypeScript
  }

  const base = basename(filePath);
  const ext = extname(filePath).toLowerCase();

  const title = basename(filePath, ext);

  return { title, content, basename: base };
}

function isScanType(value: string | undefined): value is ScanType {
  return value === 'classify' || value === 'organize' || value === 'consolidate';
}

export async function runCli(rawArgs = process.argv.slice(2)): Promise<number> {
  const [cmd, ...args] = rawArgs;

  try {
    switch (cmd) {
      case 'add': {
        const filePath = args[0];
        if (!filePath) die('Usage: notecast add <file>');

        const { title, content, basename: srcBasename } = loadNoteFromFile(filePath);

        if (isRemoteMode()) {
          const note = await api<{ id: string; title: string; status: string }>('POST', '/notes', {
            title,
            content,
          });
          process.stdout.write(
            `created note ${note.id}\n  title:  ${note.title}\n  status: ${note.status}\n`,
          );
          return 0;
        }

        // Direct mode
        const headless = await createHeadless({ requiresLLM: true });
        const note = await headless.createNoteUseCase.execute(title, content, srcBasename);

        // Move source file to vault/Source/ if vaultPath configured
        const config = await headless.userConfigRepository.get();
        if (config.vaultPath) {
          const sourceDir = join(config.vaultPath, 'Source');
          await mkdir(sourceDir, { recursive: true });
          await rename(filePath, join(sourceDir, srcBasename));
          process.stdout.write(`  moved: ${filePath} → ${join(sourceDir, srcBasename)}\n`);
        }

        // Stage 1: process inline (summary + topics + embeddings)
        try {
          await headless.noteProcessor.process(note.id);
          const processed = await headless.noteRepository.findById(note.id);
          process.stdout.write(
            `created note ${note.id}\n  title:  ${note.title}\n  status: ${processed?.status ?? 'pending'}\n`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`warning: Stage 1 failed (${msg}). Note stays pending.\n`);
          process.stdout.write(
            `created note ${note.id}\n  title:  ${note.title}\n  status: pending\n`,
          );
        }

        await headless.vaultSyncer.sync();
        await autoAdvancePipeline(headless);
        return 0;
      }

      case 'delete': {
        const query = args[0];
        if (!query) die('Usage: notecast delete <query>');

        if (isRemoteMode()) {
          process.stderr.write(
            'warning: delete is not supported in remote mode; operating on local DB directly.\n',
          );
        }

        const headless = await createHeadless();
        const note = await findNoteByQuery(query, headless.noteRepository);

        process.stdout.write(`Delete "${note.title}" [${note.status}]? (y/N) `);
        const confirm = await askLine('');
        if (confirm.trim().toLowerCase() !== 'y') {
          process.stdout.write('Cancelled.\n');
          return 0;
        }

        await headless.deleteNoteUseCase.execute(note.id);
        await headless.vaultSyncer.sync();
        process.stdout.write(`deleted: ${note.title}\n`);
        return 0;
      }

      case 'update': {
        const query = args[0];
        if (!query) die('Usage: notecast update <query>');

        if (isRemoteMode()) {
          process.stderr.write(
            'warning: update is not supported in remote mode; operating on local DB directly.\n',
          );
        }

        const headless = await createHeadless({ requiresLLM: true });
        const note = await findNoteByQuery(query, headless.noteRepository);
        const config = await headless.userConfigRepository.get();

        let editPath: string;
        let isTempFile = false;

        const vaultSourcePath =
          config.vaultPath && note.sourceFile
            ? join(config.vaultPath, 'Source', note.sourceFile)
            : null;

        if (vaultSourcePath && existsSync(vaultSourcePath)) {
          editPath = vaultSourcePath;
        } else {
          if (config.vaultPath && note.sourceFile) {
            process.stderr.write(
              `warning: source file not found in vault (${vaultSourcePath}). Editing current content in temp file.\n`,
            );
          } else {
            process.stderr.write(
              `warning: note not linked to vault source. Editing current content in temp file.\n`,
            );
          }
          editPath = join(tmpdir(), `notes-edit-${note.id}.md`);
          await writeFile(editPath, note.content, 'utf-8');
          isTempFile = true;
        }

        const editor = process.env.VISUAL ?? process.env.EDITOR ?? 'nano';
        const result = spawnSync(editor, [editPath], { stdio: 'inherit' });
        const exitCode = result.status ?? (result.signal ? -1 : 0);
        if (exitCode !== 0) {
          if (isTempFile)
            try {
              unlinkSync(editPath);
            } catch {
              /* ignore */
            }
          die(
            `Editor exited with ${result.signal ? `signal ${result.signal}` : `status ${result.status}`}`,
          );
        }

        let newContent: string;
        try {
          newContent = readFileSync(editPath, 'utf-8');
        } finally {
          if (isTempFile)
            try {
              unlinkSync(editPath);
            } catch {
              /* already gone */
            }
        }

        if (newContent!.trimEnd() === note.content.trimEnd()) {
          process.stdout.write('No changes detected.\n');
          return 0;
        }

        const updated = await headless.editNoteUseCase.execute(note.id, { content: newContent });
        if (!updated) die('Note not found after edit.');

        try {
          await headless.noteProcessor.process(note.id);
          const reloaded = await headless.noteRepository.findById(note.id);
          process.stdout.write(
            `updated: ${note.title}\n  status: ${reloaded?.status ?? 'pending'}\n`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`warning: Stage 1 failed (${msg}). Note stays pending.\n`);
          process.stdout.write(`updated: ${note.title}\n  status: pending\n`);
        }

        await headless.vaultSyncer.sync();
        await autoAdvancePipeline(headless);
        return 0;
      }

      case 'status': {
        if (isRemoteMode()) {
          const data = await api<{
            counts: {
              pending: number;
              processed: number;
              scanned: number;
              organized: number;
              failed: number;
            };
            pipeline: {
              running: boolean;
              classifyCommitCount: number;
              organizeCommitCount: number;
            };
            thresholds: {
              classify: {
                required: number;
                current: number;
                ready: boolean;
                pendingProposal: boolean;
              };
              organize: { pendingProposal: boolean };
              consolidate: { pendingProposal: boolean };
            };
          }>('GET', '/scan/status');

          const { counts, pipeline, thresholds } = data;
          const remoteConfig = await api<{ vaultPath?: string }>('GET', '/config');
          process.stdout.write(
            `\nNotes\n` +
              `  pending:    ${counts.pending}\n` +
              `  processed:  ${counts.processed}\n` +
              `  scanned:    ${counts.scanned}\n` +
              `  organized:  ${counts.organized}\n` +
              `  failed:     ${counts.failed ?? 0}${(counts.failed ?? 0) > 0 ? '  ← run "notecast retry-failed" to retry' : ''}\n\n` +
              `Pipeline  ${pipeline.running ? '(running)' : '(idle)'}\n` +
              `  classify:    ${thresholds.classify.current}/${thresholds.classify.required} processed` +
              `${thresholds.classify.ready ? ' [READY]' : ''}` +
              `${thresholds.classify.pendingProposal ? ' [PENDING PROPOSAL]' : ''}\n` +
              `  organize:    ${pipeline.classifyCommitCount} classify commits` +
              `${thresholds.organize.pendingProposal ? ' [PENDING PROPOSAL]' : ''}\n` +
              `  consolidate: ${pipeline.organizeCommitCount} organize commits` +
              `${thresholds.consolidate.pendingProposal ? ' [PENDING PROPOSAL]' : ''}\n` +
              `\nVault\n` +
              `  path: ${remoteConfig.vaultPath ? resolve(remoteConfig.vaultPath) : '(not configured)'}\n`,
          );
          return 0;
        }

        // Direct mode
        const headless = await createHeadless();
        const [counts, scanState, config, classifyPending, organizePending, consolidatePending] =
          await Promise.all([
            headless.noteRepository.countAllStatuses(),
            headless.scanProposalStore.getScanState(),
            headless.userConfigRepository.get(),
            headless.scanProposalStore.getPending('classify'),
            headless.scanProposalStore.getPending('organize'),
            headless.scanProposalStore.getPending('consolidate'),
          ]);

        const { classifyEvery } = config.pipelineConfig;
        const running = headless.scanPipeline.isRunning();

        process.stdout.write(
          `\nNotes\n` +
            `  pending:    ${counts.pending}\n` +
            `  processed:  ${counts.processed}\n` +
            `  scanned:    ${counts.scanned}\n` +
            `  organized:  ${counts.organized}\n` +
            `  failed:     ${counts.failed}${counts.failed > 0 ? '  ← run "notecast retry-failed" to retry' : ''}\n\n` +
            `Pipeline  ${running ? '(running)' : '(idle)'}\n` +
            `  classify:    ${counts.processed}/${classifyEvery} processed` +
            `${counts.processed >= classifyEvery ? ' [READY]' : ''}` +
            `${classifyPending ? ' [PENDING PROPOSAL]' : ''}\n` +
            `  organize:    ${scanState.classifyCommitCount} classify commits` +
            `${organizePending ? ' [PENDING PROPOSAL]' : ''}\n` +
            `  consolidate: ${scanState.organizeCommitCount} organize commits` +
            `${consolidatePending ? ' [PENDING PROPOSAL]' : ''}\n` +
            `\nVault\n` +
            `  path: ${config.vaultPath ? resolve(config.vaultPath) : '(not configured)'}\n`,
        );
        return 0;
      }

      case 'scan': {
        const subCmd = args[0];
        if (subCmd !== 'commit' && subCmd !== 'propose') {
          die(
            'Usage: notecast scan propose <classify|organize|consolidate>\n       notecast scan commit <classify|organize|consolidate>',
          );
        }

        const scanType = args[1];
        if (subCmd === 'propose' && !isScanType(scanType)) {
          die('Usage: notecast scan propose <classify|organize|consolidate>');
        }

        if (subCmd === 'propose') {
          if (isRemoteMode()) {
            type StatusResponse = {
              classify: { pending: boolean; proposal: unknown };
              organize: { pending: boolean; proposal: unknown };
              consolidate: { pending: boolean; proposal: unknown };
              pipeline: { running: boolean };
              thresholds: {
                classify: { ready: boolean };
                organize: { pendingProposal: boolean };
                consolidate: { pendingProposal: boolean };
              };
            };

            let status = await api<StatusResponse>('GET', '/scan/status');
            const entry = () => status[scanType];

            if (!entry().pending) {
              if (!status.pipeline.running) {
                const trigger = await api<{ status: string }>('POST', `/scan/${scanType}`);
                if (trigger.status !== 'enqueued' && trigger.status !== 'pending_proposal_exists') {
                  die(`Could not trigger ${scanType} scan: ${trigger.status}`);
                }
              }

              process.stdout.write(`waiting for ${scanType} proposal`);
              while (!entry().pending) {
                await new Promise((resolve) => setTimeout(resolve, 2000));
                status = await api<StatusResponse>('GET', '/scan/status');
                process.stdout.write('.');
              }
              process.stdout.write('\n');
            }

            const filePath = `./proposal-${scanType}.json`;
            writeFileSync(filePath, JSON.stringify(entry().proposal, null, 2));
            process.stdout.write(
              `proposal saved to ${filePath}\nEdit it, then run: notecast scan commit ${scanType}\n`,
            );
            return 0;
          }

          // Direct mode
          const headless = await createHeadless({ requiresLLM: true });

          const existing = await headless.scanProposalStore.getPending(scanType);
          if (!existing) {
            process.stdout.write(`generating ${scanType} proposal...\n`);
            if (scanType === 'classify') {
              const r = await headless.classifyScanUseCase.execute();
              if (r.unifiedProposal) {
                await headless.scanProposalStore.savePending('classify', r.unifiedProposal);
              } else {
                die('No proposal generated — not enough processed notes or no themes configured.');
              }
            } else if (scanType === 'organize') {
              const r = await headless.organizeScanUseCase.execute();
              if (r.unifiedProposal) {
                await headless.scanProposalStore.savePending('organize', r.unifiedProposal);
              } else {
                die('No organize proposal generated.');
              }
            } else if (scanType === 'consolidate') {
              await headless.noteGraphUseCase.build();
              const unified = await headless.consolidateScanUseCase.generateProposal();
              if (unified) {
                await headless.scanProposalStore.savePending('consolidate', unified);
              } else {
                die('No consolidate proposal generated.');
              }
            }
          }

          const record = await headless.scanProposalStore.getPending(scanType);
          const rawContent = record!.proposal;
          const fileContent = await enrichProposal(
            scanType,
            rawContent,
            headless.noteRepository,
            headless.themeRepository,
          );
          const vaultFilePath = await headless.vaultSyncer.saveProposal(scanType, rawContent);
          let savedPath: string;
          if (vaultFilePath) {
            savedPath = vaultFilePath;
          } else {
            const localPath = `./proposal-${scanType}.json`;
            writeFileSync(localPath, JSON.stringify(fileContent, null, 2));
            savedPath = localPath;
          }
          process.stdout.write(
            `proposal saved to ${savedPath}\nEdit it, then run: notecast scan commit ${scanType}\n`,
          );
          return 0;
        }

        // commit subcommand
        if (isRemoteMode()) {
          let effectiveType: ScanType;
          if (isScanType(scanType)) {
            effectiveType = scanType;
          } else {
            // auto-detect: find first pending proposal via status endpoint
            type ScanStatus = {
              thresholds: {
                classify: { pendingProposal: boolean };
                organize: { pendingProposal: boolean };
                consolidate: { pendingProposal: boolean };
              };
            };
            const status = await api<ScanStatus>('GET', '/scan/status');
            const found = SCAN_TYPES.find((t) => status.thresholds[t].pendingProposal);
            if (!found) die('No pending proposals. Run: notecast scan propose <type>');
            effectiveType = found;
            process.stdout.write(`auto-detected pending proposal: ${effectiveType}\n`);
          }

          const filePath = `./proposal-${effectiveType}.json`;
          let body: Record<string, unknown> | undefined;
          if (existsSync(filePath)) {
            const raw = readFileSync(filePath, 'utf-8');
            const proposal = JSON.parse(raw) as unknown;
            body = { proposal };
          }

          const result = await api<Record<string, unknown>>(
            'POST',
            `/scan/${effectiveType}/commit`,
            body,
          );
          if (existsSync(filePath)) unlinkSync(filePath);
          process.stdout.write(`${effectiveType} commit applied\n`);
          for (const [key, value] of Object.entries(result)) {
            if (value !== undefined && value !== null) {
              process.stdout.write(`  ${key}: ${value}\n`);
            }
          }
          return 0;
        }

        // Direct mode commit
        {
          const headless = await createHeadless({ requiresLLM: true });

          let effectiveType: ScanType;
          if (isScanType(scanType)) {
            effectiveType = scanType;
          } else {
            const found = (
              await Promise.all(
                SCAN_TYPES.map(async (t) => ({
                  t,
                  pending: await headless.scanProposalStore.getPending(t),
                })),
              )
            ).find(({ pending }) => !!pending)?.t;
            if (!found) die('No pending proposals. Run: notecast scan propose <type>');
            effectiveType = found;
            process.stdout.write(`auto-detected pending proposal: ${effectiveType}\n`);
          }

          const filePath = `./proposal-${effectiveType}.json`;

          if (effectiveType === 'classify') {
            type UP = import('../domain/scan/unified.proposal').UnifiedProposal;
            let proposal: UP | null = null;
            if (existsSync(filePath)) {
              proposal = JSON.parse(readFileSync(filePath, 'utf-8')) as UP;
            } else {
              const record = await headless.scanProposalStore.getPending('classify');
              if (!record) die('No pending classify proposal. Run: notecast scan propose classify');
              proposal = record.proposal;
            }
            const result = await headless.classifyScanUseCase.commit(proposal!);
            await headless.scanProposalStore.markCommitted('classify');
            const noteIds = (proposal!.assignments ?? []).map((a: { noteId: string }) => a.noteId);
            await headless.scanOrchestrator.onClassifyCommit(noteIds);
            if (existsSync(filePath)) unlinkSync(filePath);
            process.stdout.write(
              `classify commit applied\n  notesClassified: ${result.notesUpdated ?? 0}\n`,
            );
            await advanceAfterCommit(headless);
          } else if (effectiveType === 'organize') {
            type UP = import('../domain/scan/unified.proposal').UnifiedProposal;
            const record = await headless.scanProposalStore.getPending('organize');
            let proposal: UP;
            if (existsSync(filePath)) {
              proposal = JSON.parse(readFileSync(filePath, 'utf-8')) as UP;
            } else {
              if (!record) die('No pending organize proposal. Run: notecast scan propose organize');
              proposal = record.proposal;
            }
            await headless.organizeScanUseCase.commit(proposal!);
            await headless.scanProposalStore.markCommitted('organize');
            await headless.scanOrchestrator.onOrganizeCommit();
            if (existsSync(filePath)) unlinkSync(filePath);
            process.stdout.write(`organize commit applied\n`);
            await advanceAfterCommit(headless);
          } else if (effectiveType === 'consolidate') {
            type UP = import('../domain/scan/unified.proposal').UnifiedProposal;
            const record = await headless.scanProposalStore.getPending('consolidate');
            let proposal: UP;
            if (existsSync(filePath)) {
              proposal = JSON.parse(readFileSync(filePath, 'utf-8')) as UP;
            } else {
              if (!record)
                die('No pending consolidate proposal. Run: notecast scan propose consolidate');
              proposal = record.proposal;
            }
            await headless.consolidateScanUseCase.commit(proposal!);
            await headless.scanProposalStore.markCommitted('consolidate');
            await headless.scanOrchestrator.onConsolidateCommit();
            if (existsSync(filePath)) unlinkSync(filePath);
            process.stdout.write(`consolidate commit applied\n`);
            await advanceAfterCommit(headless);
          }

          await headless.vaultSyncer.sync();
          return 0;
        }
      }

      case 'config': {
        const subCmd = args[0];

        if (subCmd === 'get') {
          const OPTIONAL_FIELDS: {
            key: string;
            type: string;
            default?: string;
            description: string;
          }[] = [
            {
              key: 'vaultPath',
              type: 'string',
              description: 'Obsidian vault output folder',
            },
            {
              key: 'vaultLinks',
              type: 'bool',
              default: 'false',
              description: 'Render wikilinks between notes in vault',
            },
            {
              key: 'context',
              type: 'string',
              description: 'User context injected into LLM scans',
            },
            {
              key: 'defaultProvider',
              type: 'enum',
              description: 'openai | anthropic | ollama | codex',
            },
            {
              key: 'themeStyleInstruction',
              type: 'string',
              description: 'Custom naming instruction (requires themeStyle=custom)',
            },
            {
              key: 'llmConfig',
              type: 'json',
              description:
                'Per-step provider+model overrides: {"summary":{"provider":"ollama"},"classify":{...}}',
            },
          ];

          let config: Record<string, unknown>;
          if (isRemoteMode()) {
            config = await api<Record<string, unknown>>('GET', '/config');
          } else {
            const headless = await createHeadless();
            config = (await headless.userConfigRepository.get()) as unknown as Record<
              string,
              unknown
            >;
          }

          process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);

          const unset = OPTIONAL_FIELDS.filter((f) => config[f.key] === undefined);
          if (unset.length > 0) {
            process.stdout.write('\n# Available (not set)\n');
            const keyWidth = Math.max(...unset.map((f) => f.key.length));
            const typeWidth = Math.max(...unset.map((f) => f.type.length));
            for (const f of unset) {
              const keyPad = f.key.padEnd(keyWidth);
              const typePad = f.type.padEnd(typeWidth);
              const defaultStr = f.default ? `  (default: ${f.default})` : '';
              process.stdout.write(`  ${keyPad}  ${typePad}  ${f.description}${defaultStr}\n`);
            }
          }

          return 0;
        }

        if (subCmd === 'set') {
          const key = args[1];
          const rawValue = args[2];
          if (!key || rawValue === undefined) die('Usage: notecast config set <key> <value>');

          let value: unknown = rawValue;
          try {
            value = JSON.parse(rawValue);
          } catch {
            // keep as string
          }

          if (isRemoteMode()) {
            await api('PUT', '/config', { [key]: value });
          } else {
            const headless = await createHeadless();
            const config = await headless.userConfigRepository.get();
            (config as Record<string, unknown>)[key] = value;
            await headless.userConfigRepository.save(config);
            if (key === 'vaultPath') await headless.vaultSyncer.sync();
          }
          process.stdout.write(`config updated: ${key} = ${JSON.stringify(value)}\n`);
          return 0;
        }

        die('Usage: notecast config get  |  notecast config set <key> <value>');
        return 1;
      }

      case 'add-batch': {
        const dirPath = args[0];
        if (!dirPath) die('Usage: notecast add-batch <dir>');
        if (!existsSync(dirPath)) die(`Directory not found: ${dirPath}`);

        const files = readdirSync(dirPath)
          .map((fileName) => join(dirPath, fileName))
          .filter((fp) => {
            try {
              return statSync(fp).isFile();
            } catch {
              return false;
            }
          });

        if (files.length === 0) die('No files found in directory');

        if (isRemoteMode()) {
          const mdFiles = files.filter((fp) => ['.md', '.txt'].includes(extname(fp).toLowerCase()));
          if (mdFiles.length === 0) die('No .md or .txt files found in directory');
          const notes = mdFiles.map((fp) => {
            const { title, content } = loadNoteFromFile(fp);
            return { title, content };
          });
          const created = await api<Array<{ id: string; title: string; status: string }>>(
            'POST',
            '/notes/batch',
            notes,
          );
          process.stdout.write(`created ${created.length} notes\n`);
          for (const n of created) {
            process.stdout.write(`  ${n.id}  ${n.title}\n`);
          }
          return 0;
        }

        // Direct mode: accept any readable text file
        const headless = await createHeadless({ requiresLLM: true });
        const config = await headless.userConfigRepository.get();
        const sourceDir = config.vaultPath ? join(config.vaultPath, 'Source') : null;
        if (sourceDir) await mkdir(sourceDir, { recursive: true });

        let created = 0;
        let failed = 0;

        for (const fp of files) {
          let fileData: { title: string; content: string; basename: string };
          try {
            fileData = loadNoteFromFile(fp);
          } catch {
            process.stderr.write(`  skip: ${fp} (not readable as UTF-8)\n`);
            failed++;
            continue;
          }

          const note = await headless.createNoteUseCase.execute(
            fileData.title,
            fileData.content,
            fileData.basename,
          );

          if (sourceDir) {
            await rename(fp, join(sourceDir, fileData.basename));
          }

          try {
            await headless.noteProcessor.process(note.id);
            const processed = await headless.noteRepository.findById(note.id);
            process.stdout.write(
              `  ${note.id}  ${note.title}  [${processed?.status ?? 'pending'}]\n`,
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`  warning: Stage 1 failed for "${note.title}" (${msg})\n`);
            process.stdout.write(`  ${note.id}  ${note.title}  [pending]\n`);
          }
          created++;
        }

        process.stdout.write(
          `\ncreated ${created} notes${failed > 0 ? `, ${failed} skipped` : ''}\n`,
        );
        await headless.vaultSyncer.sync();
        await autoAdvancePipeline(headless);
        return 0;
      }

      case 'providers': {
        const headless = await createHeadless();
        const config = await headless.userConfigRepository.get();
        const active = config.defaultProvider ?? null;
        const all = detectAvailableProviders();
        const available = all.filter((p) => p.available).map((p) => p.name);
        process.stdout.write(
          `Default provider: ${active ?? '(none — run: notecast login <provider>)'}\n` +
            `Available (keys): ${available.length > 0 ? available.join(', ') : '(none)'}\n` +
            '\nAll providers:\n' +
            all.map((p) => `  ${p.available ? '✓' : '✗'} ${p.name}`).join('\n') +
            '\n  - ollama        (local, no key needed)\n',
        );
        return 0;
      }

      case 'start': {
        const { createApp } = await import('../bootstrap');
        const app = await createApp();
        app.startServer();
        process.stdout.write(`NoteCast running on port ${app.port ?? 3000}\n`);
        // Keep process alive
        await new Promise(() => {});
        return 0;
      }

      case 'reset': {
        const full = args.includes('--full');
        const headless = await createHeadless();
        const result = await headless.resetUseCase.execute(full);
        process.stdout.write(
          `reset complete (${full ? 'full' : 'soft'}): ${result.notesReset} notes affected, ${result.themesDeleted} themes deleted\n`,
        );
        await headless.vaultSyncer.sync();
        return 0;
      }

      case 'login': {
        const PROVIDERS = ['openai', 'anthropic', 'gemini', 'deepseek'];
        const provider = args[0];
        if (!provider || !PROVIDERS.includes(provider))
          die(`Usage: notecast login <provider>\nProviders: ${PROVIDERS.join(', ')}`);

        let key = args[1] ?? '';
        if (!key) {
          // Hidden input: suppress echo by piping output to a null stream
          const muted = new Writable({
            write(_c, _e, cb) {
              cb();
            },
          });
          const rl = readline.createInterface({
            input: process.stdin,
            output: muted,
            terminal: true,
          });
          process.stdout.write(`${provider} API key: `);
          key = await new Promise<string>((resolve) =>
            rl.question('', (ans) => {
              rl.close();
              resolve(ans);
            }),
          );
          process.stdout.write('\n');
        }

        if (!key.trim()) die('No key provided.');
        saveKey(provider, key.trim());
        process.stdout.write(`${provider} key saved to ~/.notes/auth.json\n`);
        process.stdout.write(`Stored providers: ${listStoredProviders().join(', ')}\n`);
        process.stdout.write(`To use it: notecast config set defaultProvider ${provider}\n`);
        return 0;
      }

      case 'codex-login': {
        const result = spawnSync('codex', ['login'], { stdio: 'inherit' });
        if (result.status !== 0) die('codex login failed');
        process.stdout.write('To use codex: notecast config set defaultProvider codex\n');
        return 0;
      }

      case 'retry-failed': {
        if (isRemoteMode()) {
          const result = await api<{ retried: number }>('POST', '/notes/retry-failed');
          process.stdout.write(`retried ${result.retried} failed note(s)\n`);
        } else {
          const headless = await createHeadless({ requiresLLM: true });
          const result = await headless.retryFailedNotesUseCase.execute();
          process.stdout.write(`retried ${result.retried} failed note(s)\n`);
        }
        return 0;
      }

      case 'note': {
        const subCmd = args[0];

        if (subCmd === 'assign' || subCmd === 'unassign') {
          const noteQuery = args[1];
          const themeIdx = args.indexOf('--theme');
          const themeQuery = themeIdx >= 0 ? args[themeIdx + 1] : undefined;
          if (!noteQuery || !themeQuery) {
            die(`Usage: notecast note ${subCmd} <note-query> --theme <theme-query>`);
          }

          const headless = await createHeadless();
          const note = await findNoteByQuery(noteQuery, headless.noteRepository);
          const theme = await findThemeByQuery(themeQuery, headless.themeRepository);

          if (subCmd === 'assign') {
            await headless.assignNoteToThemeUseCase.execute(note.id, theme.id);
            await headless.vaultSyncer.sync();
            process.stdout.write(`assigned "${note.title}" → "${theme.name}"\n`);
          } else {
            await headless.removeNoteFromThemeUseCase.execute(note.id, theme.id);
            await headless.vaultSyncer.sync();
            process.stdout.write(`removed "${note.title}" from "${theme.name}"\n`);
          }
          return 0;
        }

        die(
          'Usage: notecast note assign <note-query> --theme <theme-query> | notecast note unassign <note-query> --theme <theme-query>',
        );
        return 1;
      }

      case 'theme': {
        const subCmd = args[0];

        if (subCmd === 'list') {
          if (isRemoteMode()) {
            const themes = await api<
              Array<{ id: string; name: string; parentIds: string[]; noteIds: string[] }>
            >('GET', '/themes');
            if (themes.length === 0) {
              process.stdout.write('No themes.\n');
            } else {
              for (const t of themes) {
                process.stdout.write(
                  `  ${t.id}  ${t.name}  (${t.noteIds.length} notes)${t.parentIds.length > 0 ? `  parents: ${t.parentIds.join(', ')}` : '  (root)'}\n`,
                );
              }
            }
          } else {
            const headless = await createHeadless();
            const themes = await headless.listThemesUseCase.execute();
            if (themes.length === 0) {
              process.stdout.write('No themes.\n');
            } else {
              const nameById = new Map(themes.map((t) => [t.id, t.name]));
              for (const t of themes) {
                const parentNames = t.parentIds.map((p) => nameById.get(p) ?? p).join(', ');
                process.stdout.write(
                  `  ${t.id}  ${t.name}  (${t.noteIds.length} notes)${t.parentIds.length > 0 ? `  parents: ${parentNames}` : '  (root)'}\n`,
                );
              }
            }
          }
          return 0;
        }

        if (subCmd === 'add') {
          const name = args[1];
          if (!name)
            die('Usage: notecast theme add <name> [--parent <name-or-id>] [--desc <text>]');

          const parentIdx = args.indexOf('--parent');
          const parentArg = parentIdx >= 0 ? args[parentIdx + 1] : undefined;
          const descIdx = args.indexOf('--desc');
          const descArg = descIdx >= 0 ? args[descIdx + 1] : undefined;

          if (isRemoteMode()) {
            let parentId: string | undefined;
            if (parentArg) {
              const themes = await api<Array<{ id: string; name: string }>>('GET', '/themes');
              const match = themes.find((t) => t.name === parentArg || t.id === parentArg);
              if (!match) die(`Parent theme not found: ${parentArg}`);
              parentId = match.id;
            }
            const theme = await api<{ id: string; name: string }>('POST', '/themes', {
              name,
              parentId,
              description: descArg,
            });
            process.stdout.write(`created theme ${theme.id}  ${theme.name}\n`);
          } else {
            const headless = await createHeadless();
            let parentId: string | undefined;
            if (parentArg) {
              const byName = await headless.themeRepository.findByName(parentArg);
              const resolved = byName ?? (await headless.themeRepository.findById(parentArg));
              if (!resolved) die(`Parent theme not found: ${parentArg}`);
              parentId = resolved.id;
            }
            const theme = await headless.createThemeUseCase.execute({
              name,
              parentId,
              description: descArg,
            });
            process.stdout.write(`created theme ${theme.id}  ${theme.name}\n`);
          }
          return 0;
        }

        if (subCmd === 'remove') {
          const query = args[1];
          if (!query) die('Usage: notecast theme remove <query>');

          if (isRemoteMode()) {
            const themes = await api<Array<{ id: string; name: string }>>('GET', '/themes');
            const lower = query.toLowerCase();
            const matches = themes.filter((t) => t.name.toLowerCase().includes(lower));
            if (matches.length === 0) die(`No themes found matching: "${query}"`);
            let theme = matches[0];
            if (matches.length > 1) {
              process.stdout.write('Multiple themes found:\n');
              for (let i = 0; i < matches.length; i++) {
                process.stdout.write(`  ${i + 1}. ${matches[i].name}\n`);
              }
              const choice = await askLine(`Select (1-${matches.length}): `);
              const idx = parseInt(choice, 10) - 1;
              if (Number.isNaN(idx) || idx < 0 || idx >= matches.length) die('Invalid selection');
              theme = matches[idx];
            }
            process.stdout.write(`Delete "${theme.name}"? (y/N) `);
            const confirm = await askLine('');
            if (confirm.trim().toLowerCase() !== 'y') {
              process.stdout.write('Cancelled.\n');
              return 0;
            }
            await api('DELETE', `/themes/${theme.id}`);
            process.stdout.write(`deleted: ${theme.name}\n`);
          } else {
            const headless = await createHeadless();
            const all = await headless.themeRepository.findAll();
            const lower = query.toLowerCase();
            const matches = all.filter((t) => t.name.toLowerCase().includes(lower));
            if (matches.length === 0) die(`No themes found matching: "${query}"`);
            let theme = matches[0];
            if (matches.length > 1) {
              process.stdout.write('Multiple themes found:\n');
              for (let i = 0; i < matches.length; i++) {
                process.stdout.write(`  ${i + 1}. ${matches[i].name}\n`);
              }
              const choice = await askLine(`Select (1-${matches.length}): `);
              const idx = parseInt(choice, 10) - 1;
              if (Number.isNaN(idx) || idx < 0 || idx >= matches.length) die('Invalid selection');
              theme = matches[idx];
            }
            process.stdout.write(`Delete "${theme.name}"? (y/N) `);
            const confirm = await askLine('');
            if (confirm.trim().toLowerCase() !== 'y') {
              process.stdout.write('Cancelled.\n');
              return 0;
            }
            await headless.deleteThemeUseCase.execute(theme.id);
            await headless.vaultSyncer.sync();
            process.stdout.write(`deleted: ${theme.name}\n`);
          }
          return 0;
        }

        if (subCmd === 'update') {
          const query = args[1];
          if (!query)
            die('Usage: notecast theme update <query> [--name <n>] [--parent <p>] [--desc <d>]');

          const nameIdx = args.indexOf('--name');
          const newName = nameIdx >= 0 ? args[nameIdx + 1] : undefined;
          const parentIdx = args.indexOf('--parent');
          const parentArg = parentIdx >= 0 ? args[parentIdx + 1] : undefined;
          const descIdx = args.indexOf('--desc');
          const newDesc = descIdx >= 0 ? args[descIdx + 1] : undefined;

          if (!newName && parentArg === undefined && !newDesc) {
            die('Provide at least one of: --name, --parent, --desc');
          }

          const headless = await createHeadless();
          const theme = await findThemeByQuery(query, headless.themeRepository);

          let parentIds: string[] | undefined;
          if (parentArg !== undefined) {
            if (parentArg === '') {
              parentIds = [];
            } else {
              const parent = await findThemeByQuery(parentArg, headless.themeRepository);
              parentIds = [parent.id];
            }
          }

          const updated = await headless.updateThemeUseCase.execute(theme.id, {
            name: newName,
            description: newDesc,
            parentIds,
          });
          await headless.vaultSyncer.sync();
          process.stdout.write(`updated theme: ${updated.id}  ${updated.name}\n`);
          return 0;
        }

        if (subCmd === 'merge') {
          const sourceQuery = args[1];
          const intoIdx = args.indexOf('--into');
          const targetQuery = intoIdx >= 0 ? args[intoIdx + 1] : undefined;
          if (!sourceQuery || !targetQuery)
            die('Usage: notecast theme merge <source-query> --into <target-query>');

          const headless = await createHeadless();
          const source = await findThemeByQuery(sourceQuery, headless.themeRepository);
          const target = await findThemeByQuery(targetQuery, headless.themeRepository);

          process.stdout.write(`Merge "${source.name}" into "${target.name}"? (y/N) `);
          const confirm = await askLine('');
          if (confirm.trim().toLowerCase() !== 'y') {
            process.stdout.write('Cancelled.\n');
            return 0;
          }

          const result = await headless.mergeThemesUseCase.execute(source.id, target.id);
          await headless.vaultSyncer.sync();
          process.stdout.write(
            `merged: ${result.notesMoved} notes moved, ${result.childrenRerouted} children rerouted, "${source.name}" deleted\n`,
          );
          return 0;
        }

        die(
          'Usage: notecast theme list | notecast theme add <name> [--parent <name-or-id>] [--desc <text>] | notecast theme remove <query> | notecast theme update <query> [--name <n>] [--parent <p>] [--desc <d>] | notecast theme merge <source> --into <target>',
        );
        return 1;
      }

      default:
        process.stdout.write(HELP_TEXT);
        return 0;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${msg}\n`);
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await runCli(process.argv.slice(2)));
}
