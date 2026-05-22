import type { Note } from '../note/note.entity';
import type { UnifiedProposal } from './unified.proposal';

export type ScanType = 'classify' | 'organize' | 'consolidate';

export interface ThemeSplit {
  parentThemeId: string;
  newSubTheme: { name: string; description?: string };
  noteIds: string[];
}

export interface ThemeMerge {
  sourceThemeId: string;
  targetThemeId: string;
}

export interface NoteRedistribution {
  noteId: string;
  fromThemeId: string;
  toThemeId: string;
}

export interface ThemeConnection {
  themeId: string;
  parentId: string;
}

export interface MultiAssignment {
  noteId: string;
  themeId: string;
}

/** Unified proposal for Organize and Consolidate (splits, merges, redistributions, removals, connections, multi-assign). */
export interface StructureProposal {
  splits: ThemeSplit[];
  merges: ThemeMerge[];
  redistributions: NoteRedistribution[];
  removals?: string[];
  addParents?: ThemeConnection[];
  removeParents?: ThemeConnection[];
  multiAssignments?: MultiAssignment[];
}

export interface ScanResult {
  scanType: ScanType;
  notesProcessed: number;
  notes: Note[];
  unifiedProposal?: UnifiedProposal;
  executedAt: Date;
}

export interface CommitResult {
  themesCreated: number;
  themesMerged: number;
  notesUpdated: number;
  notesFinalized: number;
}

export interface IScan {
  readonly type: ScanType;
  execute(): Promise<ScanResult>;
}

export interface ConsolidateCommitResult {
  reroutingsApplied: number;
  mergesApplied: number;
  removalsApplied: number;
  addParentsApplied: number;
  removeParentsApplied: number;
  multiAssignmentsApplied: number;
  skipped: number;
}
