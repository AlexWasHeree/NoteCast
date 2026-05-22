import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFile as fsReadFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Note } from '../../domain/note/note.entity';
import type { Theme } from '../../domain/theme/theme.entity';
import {
  buildDepthMap,
  buildNameMap,
  renderThemeMd,
  sanitizeFilename,
  VaultSyncer,
} from './vault.syncer';

describe('sanitizeFilename', () => {
  test('replaces / with -', () => {
    expect(sanitizeFilename('A/B')).toBe('A-B');
  });
  test('removes illegal characters', () => {
    expect(sanitizeFilename('file:name?')).toBe('filename');
  });
  test('truncates at 200 chars', () => {
    expect(sanitizeFilename('a'.repeat(300))).toHaveLength(200);
  });
  test('empty string fallback handled by caller', () => {
    expect(sanitizeFilename('')).toBe('');
  });
});

describe('buildNameMap', () => {
  test('assigns sanitized names', () => {
    const items = [
      { id: '1', name: 'Foo' },
      { id: '2', name: 'Bar' },
    ];
    const map = buildNameMap(items);
    expect(map.get('1')).toBe('Foo');
    expect(map.get('2')).toBe('Bar');
  });
  test('resolves collisions with suffix', () => {
    const items = [
      { id: '1', name: 'Foo' },
      { id: '2', name: 'Foo' },
      { id: '3', name: 'Foo' },
    ];
    const map = buildNameMap(items);
    expect(map.get('1')).toBe('Foo');
    expect(map.get('2')).toBe('Foo-2');
    expect(map.get('3')).toBe('Foo-3');
  });
});

describe('buildDepthMap', () => {
  test('roots have depth 0', () => {
    const themes: Theme[] = [makeTheme('1', 'Root', []), makeTheme('2', 'Child', ['1'])];
    const map = buildDepthMap(themes);
    expect(map.get('1')).toBe(0);
    expect(map.get('2')).toBe(1);
  });
  test('multi-parent takes min depth', () => {
    const themes: Theme[] = [
      makeTheme('1', 'Root1', []),
      makeTheme('2', 'Root2', []),
      makeTheme('3', 'Child', ['1', '2']),
    ];
    const map = buildDepthMap(themes);
    expect(map.get('3')).toBe(1);
  });
});

describe('renderThemeMd', () => {
  test('renders root theme with notes', () => {
    const theme = makeTheme('t1', 'Tech', []);
    const themeNameMap = new Map([['t1', 'Tech']]);
    const noteNameMap = new Map([['n1', 'My Note']]);
    theme.noteIds = ['n1'];
    const md = renderThemeMd(theme, 0, ['SubTech'], themeNameMap, noteNameMap);
    expect(md).toContain('tags: [theme, root');
    expect(md).toContain('# Tech');
    expect(md).toContain('**Children:** [[SubTech]]');
    expect(md).toContain('- [[Source/My Note]]');
  });

  test('leaf tag when no children', () => {
    const theme = makeTheme('t1', 'Leaf', []);
    const md = renderThemeMd(theme, 1, [], new Map([['t1', 'Leaf']]), new Map());
    expect(md).toContain('leaf');
  });
});

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeTheme(id: string, name: string, parentIds: string[]): Theme {
  return {
    id,
    name,
    parentIds,
    noteIds: [],
    createdAt: new Date(),
  };
}

function makeNote(id: string, title: string): Note {
  return {
    id,
    title,
    content: '',
    status: 'processed',
    themeIds: [],
    createdAt: new Date(),
    summary: '',
    topics: [],
    contentVector: [],
    summaryVector: [],
    relatedNoteIds: [],
  } as unknown as Note;
}

// ── Stubs ──────────────────────────────────────────────────────────────────────

class StubNoteRepo {
  private notes: Note[] = [];
  setNotes(notes: Note[]) {
    this.notes = notes;
  }
  async findAll() {
    return this.notes;
  }
}

class StubThemeRepo {
  private themes: Theme[] = [];
  setThemes(themes: Theme[]) {
    this.themes = themes;
  }
  async findAll() {
    return this.themes;
  }
}

class StubConfigRepo {
  private vaultPath: string | undefined;
  setVaultPath(p: string) {
    this.vaultPath = p;
  }
  async get() {
    return {
      themeStyle: 'short-phrase' as const,
      baseThemes: [],
      pipelineConfig: {
        classifyEvery: 10,
        organizeAfterClassifies: 2,
        consolidateAfterOrganizes: 3,
      },
      vaultPath: this.vaultPath,
    };
  }
  async save() {}
}

// ── Integration tests ──────────────────────────────────────────────────────────

describe('VaultSyncer.sync()', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vault-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('no-op when vaultPath not configured', async () => {
    const syncer = new VaultSyncer(
      new StubNoteRepo() as any,
      new StubThemeRepo() as any,
      new StubConfigRepo() as any,
    );
    await syncer.sync(); // should not throw
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(dir)).toHaveLength(0);
  });

  test('creates theme files and dashboard', async () => {
    const noteRepo = new StubNoteRepo();
    const themeRepo = new StubThemeRepo();
    const configRepo = new StubConfigRepo();
    configRepo.setVaultPath(dir);

    const theme = makeTheme('t1', 'Tech', []);
    theme.noteIds = ['n1'];
    themeRepo.setThemes([theme]);
    noteRepo.setNotes([makeNote('n1', 'My First Note')]);

    const syncer = new VaultSyncer(noteRepo as any, themeRepo as any, configRepo as any);
    await syncer.sync();

    const themeFile = await fsReadFile(join(dir, 'Themes', 'Tech.md'), 'utf-8');
    expect(themeFile).toContain('# Tech');
    expect(themeFile).toContain('[[Source/My First Note]]');

    const dashboard = await fsReadFile(join(dir, '_Dashboard.md'), 'utf-8');
    expect(dashboard).toContain('themes total: 1');
  });

  test('removes stale theme files on second sync', async () => {
    const noteRepo = new StubNoteRepo();
    const themeRepo = new StubThemeRepo();
    const configRepo = new StubConfigRepo();
    configRepo.setVaultPath(dir);

    const theme = makeTheme('t1', 'Tech', []);
    themeRepo.setThemes([theme]);

    const syncer = new VaultSyncer(noteRepo as any, themeRepo as any, configRepo as any);
    await syncer.sync();

    const firstSync = await fsReadFile(join(dir, 'Themes', 'Tech.md'), 'utf-8');
    expect(firstSync).toContain('Tech');

    themeRepo.setThemes([]);
    await syncer.sync();

    let exists = true;
    try {
      await fsReadFile(join(dir, 'Themes', 'Tech.md'), 'utf-8');
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  test('writes .obsidian/graph.json on first sync', async () => {
    const configRepo = new StubConfigRepo();
    configRepo.setVaultPath(dir);
    const syncer = new VaultSyncer(
      new StubNoteRepo() as any,
      new StubThemeRepo() as any,
      configRepo as any,
    );
    await syncer.sync();

    const graphJson = JSON.parse(await fsReadFile(join(dir, '.obsidian', 'graph.json'), 'utf-8'));
    expect(Array.isArray(graphJson.colorGroups)).toBe(true);
    expect(graphJson.colorGroups).toHaveLength(4);
  });

  test('does not overwrite existing .obsidian/graph.json', async () => {
    const configRepo = new StubConfigRepo();
    configRepo.setVaultPath(dir);

    const { mkdir: fsMkdir, writeFile } = await import('node:fs/promises');
    await fsMkdir(join(dir, '.obsidian'), { recursive: true });
    const custom = { colorGroups: [{ query: 'path:Themes/', color: { a: 1, rgb: 0xff0000 } }] };
    await writeFile(join(dir, '.obsidian', 'graph.json'), JSON.stringify(custom), 'utf-8');

    const syncer = new VaultSyncer(
      new StubNoteRepo() as any,
      new StubThemeRepo() as any,
      configRepo as any,
    );
    await syncer.sync();

    const graphJson = JSON.parse(await fsReadFile(join(dir, '.obsidian', 'graph.json'), 'utf-8'));
    expect(graphJson.colorGroups).toHaveLength(1);
    expect(graphJson.colorGroups[0].query).toBe('path:Themes/');
  });
});
