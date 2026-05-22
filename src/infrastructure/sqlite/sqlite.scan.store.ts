import type { Database } from 'bun:sqlite';
import type {
  IScanProposalStore,
  ScanProposalRecord,
  ScanState,
  ScanType,
} from '../../domain/scan/scan.state';
import type { UnifiedProposal } from '../../domain/scan/unified.proposal';

interface RawProposalRow {
  type: string;
  proposal: string;
  status: string;
  created_at: string;
}

interface RawStateRow {
  organized_count_at_last_consolidate: number;
  classify_commit_count: number;
  organize_commit_count: number;
}

export class SQLiteScanProposalStore implements IScanProposalStore {
  constructor(private db: Database) {}

  async savePending(type: ScanType, proposal: UnifiedProposal): Promise<void> {
    this.db.run(
      `INSERT OR REPLACE INTO scan_proposals (type, proposal, status, created_at)
       VALUES (?, ?, 'pending', datetime('now'))`,
      [type, JSON.stringify(proposal)],
    );
  }

  async getPending(type: ScanType): Promise<ScanProposalRecord | null> {
    const row = this.db
      .query<RawProposalRow, [string]>(
        `SELECT * FROM scan_proposals WHERE type = ? AND status = 'pending'`,
      )
      .get(type);
    if (!row) return null;
    return {
      type: row.type as ScanType,
      proposal: JSON.parse(row.proposal) as UnifiedProposal,
      status: row.status as 'pending' | 'committed',
      createdAt: new Date(row.created_at),
    };
  }

  async markCommitted(type: ScanType): Promise<void> {
    this.db.run(`UPDATE scan_proposals SET status = 'committed' WHERE type = ?`, [type]);
  }

  async getScanState(): Promise<ScanState> {
    const row = this.db
      .query<RawStateRow, []>(
        `SELECT organized_count_at_last_consolidate, classify_commit_count, organize_commit_count
       FROM scan_state WHERE id = 1`,
      )
      .get();
    return {
      organizedCountAtLastConsolidate: row?.organized_count_at_last_consolidate ?? 0,
      classifyCommitCount: row?.classify_commit_count ?? 0,
      organizeCommitCount: row?.organize_commit_count ?? 0,
    };
  }

  async updateScanState(state: Partial<ScanState>): Promise<void> {
    if (state.organizedCountAtLastConsolidate !== undefined) {
      this.db.run(
        `UPDATE scan_state SET organized_count_at_last_consolidate = ?, updated_at = datetime('now') WHERE id = 1`,
        [state.organizedCountAtLastConsolidate],
      );
    }
    if (state.classifyCommitCount !== undefined) {
      this.db.run(
        `UPDATE scan_state SET classify_commit_count = ?, updated_at = datetime('now') WHERE id = 1`,
        [state.classifyCommitCount],
      );
    }
    if (state.organizeCommitCount !== undefined) {
      this.db.run(
        `UPDATE scan_state SET organize_commit_count = ?, updated_at = datetime('now') WHERE id = 1`,
        [state.organizeCommitCount],
      );
    }
  }

  async incrementCommitCount(type: 'classify' | 'organize'): Promise<number> {
    if (type === 'classify') {
      this.db.run(
        `UPDATE scan_state SET classify_commit_count = classify_commit_count + 1, updated_at = datetime('now') WHERE id = 1`,
      );
      const row = this.db
        .query<{ count: number }, []>(
          `SELECT classify_commit_count as count FROM scan_state WHERE id = 1`,
        )
        .get();
      return row?.count ?? 0;
    } else {
      this.db.run(
        `UPDATE scan_state SET organize_commit_count = organize_commit_count + 1, updated_at = datetime('now') WHERE id = 1`,
      );
      const row = this.db
        .query<{ count: number }, []>(
          `SELECT organize_commit_count as count FROM scan_state WHERE id = 1`,
        )
        .get();
      return row?.count ?? 0;
    }
  }
}
