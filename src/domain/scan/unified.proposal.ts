export interface ProposalContextTheme {
  id: string;
  name: string;
  isNew?: true;
}

export interface ProposalContextNote {
  id: string;
  title: string;
}

export interface UnifiedProposal {
  /** Auto-generated at proposal creation. Read-only for the human. Commit does not depend on it. */
  context: {
    themes: ProposalContextTheme[];
    notes: ProposalContextNote[];
  };

  /** Assign processed notes to themes. Transitions note status: processed → scanned. */
  assignments: {
    noteId: string;
    themeId: string;
  }[];

  /**
   * Create new themes. If `id` is provided, it is used as-is (allows cross-referencing within
   * the same proposal). If omitted, commit generates a nanoid(10). If `id` already exists in
   * the database, the entry is skipped (idempotent).
   */
  createThemes: {
    id?: string;
    name: string;
    description?: string;
    parentIds: string[];
  }[];

  /** Move notes from a parent theme to an already-existing (or newly created) subtheme. */
  splits: {
    parentThemeId: string;
    newThemeId: string;
    noteIds: string[];
  }[];

  merges: {
    sourceThemeId: string;
    targetThemeId: string;
  }[];

  redistributions: {
    noteId: string;
    fromThemeId: string;
    toThemeId: string;
  }[];

  /** Theme IDs to remove. Only empty themes are removed; base themes are protected. */
  removals: string[];

  addParents: {
    themeId: string;
    parentId: string;
  }[];

  removeParents: {
    themeId: string;
    parentId: string;
  }[];

  /** Add a note to an additional theme without removing it from current themes. */
  multiAssignments: {
    noteId: string;
    themeId: string;
  }[];
}

export function emptyUnifiedProposal(): UnifiedProposal {
  return {
    context: { themes: [], notes: [] },
    assignments: [],
    createThemes: [],
    splits: [],
    merges: [],
    redistributions: [],
    removals: [],
    addParents: [],
    removeParents: [],
    multiAssignments: [],
  };
}
