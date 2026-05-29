import { describe, expect, test } from 'bun:test';
import type { Note } from '../../../domain/note/note.entity';
import type { UnifiedProposal } from '../../../domain/scan/unified.proposal';
import { emptyUnifiedProposal } from '../../../domain/scan/unified.proposal';
import type { Theme } from '../../../domain/theme/theme.entity';
import {
  InMemoryNoteRepository,
  InMemoryThemeRepository,
} from '../../../infrastructure/notes/adapters';
import { applyUnifiedProposal, removeAncestorThemeIds } from './unified.apply';

function makeTheme(id: string, name: string, noteIds: string[], parentIds: string[] = []): Theme {
  return { id, name, noteIds, createdAt: new Date(), parentIds };
}

function makeNote(id: string, status: Note['status'] = 'processed', themeIds: string[] = []): Note {
  return {
    id,
    title: `Note ${id}`,
    content: '',
    status,
    themeIds,
    createdAt: new Date(),
    summary: '',
    topics: [],
    contentVector: [],
    summaryVector: [],
    relatedNoteIds: [],
  };
}

describe('removeAncestorThemeIds (multi-parent)', () => {
  test('removes ancestor when descendant present (single parent)', () => {
    const themeMap = new Map<string, { parentIds: string[] }>([
      ['root', { parentIds: [] }],
      ['child', { parentIds: ['root'] }],
    ]);
    expect(removeAncestorThemeIds(['root', 'child'], themeMap)).toEqual(['child']);
  });

  test('removes ancestor reachable via transitive path', () => {
    const themeMap = new Map<string, { parentIds: string[] }>([
      ['root', { parentIds: [] }],
      ['mid', { parentIds: ['root'] }],
      ['leaf', { parentIds: ['mid'] }],
    ]);
    expect(removeAncestorThemeIds(['root', 'leaf'], themeMap)).toEqual(['leaf']);
  });

  test('keeps unrelated themes', () => {
    const themeMap = new Map<string, { parentIds: string[] }>([
      ['a', { parentIds: [] }],
      ['b', { parentIds: [] }],
    ]);
    expect(removeAncestorThemeIds(['a', 'b'], themeMap)).toEqual(['a', 'b']);
  });

  test('multi-parent: removes ancestor reachable via second parent', () => {
    const themeMap = new Map<string, { parentIds: string[] }>([
      ['a', { parentIds: [] }],
      ['b', { parentIds: [] }],
      ['c', { parentIds: ['a', 'b'] }],
    ]);
    expect(removeAncestorThemeIds(['a', 'c'], themeMap)).toEqual(['c']);
  });

  test('empty input returns empty', () => {
    expect(removeAncestorThemeIds([], new Map())).toEqual([]);
  });
});

describe('applyUnifiedProposal — createThemes', () => {
  test('creates a new theme with the provided id', async () => {
    const themeRepo = new InMemoryThemeRepository();
    const noteRepo = new InMemoryNoteRepository();
    const proposal: UnifiedProposal = {
      context: { themes: [], notes: [] },
      assignments: [],
      createThemes: [{ id: 'myid', name: 'Test Theme', parentIds: [] }],
      splits: [],
      merges: [],
      redistributions: [],
      removals: [],
      addParents: [],
      removeParents: [],
      multiAssignments: [],
    };
    const result = await applyUnifiedProposal(proposal, noteRepo, themeRepo);
    expect(result.themesCreated).toBe(1);
    const theme = await themeRepo.findById('myid');
    expect(theme?.name).toBe('Test Theme');
    expect(theme?.parentIds).toEqual([]);
  });

  test('generates id when omitted', async () => {
    const themeRepo = new InMemoryThemeRepository();
    const noteRepo = new InMemoryNoteRepository();
    const proposal: UnifiedProposal = {
      context: { themes: [], notes: [] },
      assignments: [],
      createThemes: [{ name: 'Auto ID Theme', parentIds: [] }],
      splits: [],
      merges: [],
      redistributions: [],
      removals: [],
      addParents: [],
      removeParents: [],
      multiAssignments: [],
    };
    const result = await applyUnifiedProposal(proposal, noteRepo, themeRepo);
    expect(result.themesCreated).toBe(1);
    const all = await themeRepo.findAll();
    expect(all.length).toBe(1);
    expect(all[0].name).toBe('Auto ID Theme');
    expect(all[0].id.length).toBe(10);
  });

  test('skips createTheme if id already exists (idempotent)', async () => {
    const themeRepo = new InMemoryThemeRepository();
    const noteRepo = new InMemoryNoteRepository();
    await themeRepo.save(makeTheme('existing', 'Existing', []));
    const proposal: UnifiedProposal = {
      context: { themes: [], notes: [] },
      assignments: [],
      createThemes: [{ id: 'existing', name: 'Should be skipped', parentIds: [] }],
      splits: [],
      merges: [],
      redistributions: [],
      removals: [],
      addParents: [],
      removeParents: [],
      multiAssignments: [],
    };
    const result = await applyUnifiedProposal(proposal, noteRepo, themeRepo);
    expect(result.themesCreated).toBe(0);
    const theme = await themeRepo.findById('existing');
    expect(theme?.name).toBe('Existing');
  });

  test('newly created theme can be referenced in splits', async () => {
    const themeRepo = new InMemoryThemeRepository();
    const noteRepo = new InMemoryNoteRepository();
    await themeRepo.save(makeTheme('parent', 'Parent', ['n1']));
    await noteRepo.save(makeNote('n1', 'scanned', ['parent']));
    const proposal: UnifiedProposal = {
      context: { themes: [], notes: [] },
      assignments: [],
      createThemes: [{ id: 'child', name: 'Child', parentIds: ['parent'] }],
      splits: [{ parentThemeId: 'parent', newThemeId: 'child', noteIds: ['n1'] }],
      merges: [],
      redistributions: [],
      removals: [],
      addParents: [],
      removeParents: [],
      multiAssignments: [],
    };
    const result = await applyUnifiedProposal(proposal, noteRepo, themeRepo);
    expect(result.themesCreated).toBe(1);
    expect(result.notesMovedBySplits).toBe(1);
    const note = await noteRepo.findById('n1');
    expect(note?.themeIds).toContain('child');
    expect(note?.themeIds).not.toContain('parent');
  });
});

describe('applyUnifiedProposal — assignments', () => {
  test('assigns note to theme and transitions processed → scanned', async () => {
    const themeRepo = new InMemoryThemeRepository();
    const noteRepo = new InMemoryNoteRepository();
    await themeRepo.save(makeTheme('t1', 'Theme 1', []));
    await noteRepo.save(makeNote('n1', 'processed'));
    const proposal: UnifiedProposal = {
      context: { themes: [], notes: [] },
      assignments: [{ noteId: 'n1', themeId: 't1' }],
      createThemes: [],
      splits: [],
      merges: [],
      redistributions: [],
      removals: [],
      addParents: [],
      removeParents: [],
      multiAssignments: [],
    };
    const result = await applyUnifiedProposal(proposal, noteRepo, themeRepo);
    expect(result.assignmentsApplied).toBe(1);
    const note = await noteRepo.findById('n1');
    expect(note?.status).toBe('scanned');
    expect(note?.themeIds).toContain('t1');
    const theme = await themeRepo.findById('t1');
    expect(theme?.noteIds).toContain('n1');
  });

  test('skips assignment for non-processed note', async () => {
    const themeRepo = new InMemoryThemeRepository();
    const noteRepo = new InMemoryNoteRepository();
    await themeRepo.save(makeTheme('t1', 'Theme 1', ['n1']));
    await noteRepo.save(makeNote('n1', 'organized', ['t1']));
    const proposal: UnifiedProposal = {
      context: { themes: [], notes: [] },
      assignments: [{ noteId: 'n1', themeId: 't1' }],
      createThemes: [],
      splits: [],
      merges: [],
      redistributions: [],
      removals: [],
      addParents: [],
      removeParents: [],
      multiAssignments: [],
    };
    const result = await applyUnifiedProposal(proposal, noteRepo, themeRepo);
    expect(result.assignmentsApplied).toBe(0);
    const note = await noteRepo.findById('n1');
    expect(note?.status).toBe('organized');
  });
});

describe('applyUnifiedProposal — addParents', () => {
  test('adds parent to theme', async () => {
    const themeRepo = new InMemoryThemeRepository();
    const noteRepo = new InMemoryNoteRepository();
    await themeRepo.save(makeTheme('a', 'Theme a', [], []));
    await themeRepo.save(makeTheme('b', 'Theme b', [], ['a']));
    await themeRepo.save(makeTheme('c', 'Theme c', [], []));
    const proposal: UnifiedProposal = {
      context: { themes: [], notes: [] },
      assignments: [],
      createThemes: [],
      splits: [],
      merges: [],
      redistributions: [],
      removals: [],
      addParents: [{ themeId: 'b', parentId: 'c' }],
      removeParents: [],
      multiAssignments: [],
    };
    const result = await applyUnifiedProposal(proposal, noteRepo, themeRepo);
    expect(result.addParentsApplied).toBe(1);
    const b = await themeRepo.findById('b');
    expect(b?.parentIds).toContain('a');
    expect(b?.parentIds).toContain('c');
  });

  test('skips addParent if would create cycle', async () => {
    const themeRepo = new InMemoryThemeRepository();
    const noteRepo = new InMemoryNoteRepository();
    await themeRepo.save(makeTheme('a', 'Theme a', [], []));
    await themeRepo.save(makeTheme('b', 'Theme b', [], ['a']));
    const proposal: UnifiedProposal = {
      context: { themes: [], notes: [] },
      assignments: [],
      createThemes: [],
      splits: [],
      merges: [],
      redistributions: [],
      removals: [],
      addParents: [{ themeId: 'a', parentId: 'b' }],
      removeParents: [],
      multiAssignments: [],
    };
    const result = await applyUnifiedProposal(proposal, noteRepo, themeRepo);
    expect(result.addParentsApplied).toBe(0);
    expect(result.skipped).toBe(1);
  });
});

describe('applyUnifiedProposal — merges', () => {
  test('re-parents children of source theme to target theme', async () => {
    const themeRepo = new InMemoryThemeRepository();
    const noteRepo = new InMemoryNoteRepository();
    await themeRepo.save(makeTheme('src', 'Source', [], []));
    await themeRepo.save(makeTheme('tgt', 'Target', [], []));
    await themeRepo.save(makeTheme('child', 'Child', [], ['src']));

    const proposal = {
      ...emptyUnifiedProposal(),
      merges: [{ sourceThemeId: 'src', targetThemeId: 'tgt' }],
    };
    await applyUnifiedProposal(proposal, noteRepo, themeRepo);

    const child = await themeRepo.findById('child');
    expect(child?.parentIds).not.toContain('src');
    expect(child?.parentIds).toContain('tgt');
  });

  test('child with multiple parents: source replaced by target, others kept', async () => {
    const themeRepo = new InMemoryThemeRepository();
    const noteRepo = new InMemoryNoteRepository();
    await themeRepo.save(makeTheme('src', 'Source', [], []));
    await themeRepo.save(makeTheme('tgt', 'Target', [], []));
    await themeRepo.save(makeTheme('other', 'Other', [], []));
    await themeRepo.save(makeTheme('child', 'Child', [], ['src', 'other']));

    const proposal = {
      ...emptyUnifiedProposal(),
      merges: [{ sourceThemeId: 'src', targetThemeId: 'tgt' }],
    };
    await applyUnifiedProposal(proposal, noteRepo, themeRepo);

    const child = await themeRepo.findById('child');
    expect(child?.parentIds).not.toContain('src');
    expect(child?.parentIds).toContain('tgt');
    expect(child?.parentIds).toContain('other');
  });

  test('merge without children moves notes and removes source', async () => {
    const themeRepo = new InMemoryThemeRepository();
    const noteRepo = new InMemoryNoteRepository();
    await themeRepo.save(makeTheme('src', 'Source', ['n1'], []));
    await themeRepo.save(makeTheme('tgt', 'Target', [], []));
    await noteRepo.save(makeNote('n1', 'organized', ['src']));

    const proposal = {
      ...emptyUnifiedProposal(),
      merges: [{ sourceThemeId: 'src', targetThemeId: 'tgt' }],
    };
    const result = await applyUnifiedProposal(proposal, noteRepo, themeRepo);

    expect(result.themesMerged).toBe(1);
    expect(await themeRepo.findById('src')).toBeNull();
    const note = await noteRepo.findById('n1');
    expect(note?.themeIds).toContain('tgt');
    expect(note?.themeIds).not.toContain('src');
  });
});
