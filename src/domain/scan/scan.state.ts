import type { ScanType } from './scan.types';
import type { UnifiedProposal } from './unified.proposal';

export type { ScanType };
export type ScanProposalStatus = 'pending' | 'committed';

export interface ScanProposalRecord {
  type: ScanType;
  proposal: UnifiedProposal;
  status: ScanProposalStatus;
  createdAt: Date;
}

export interface ScanState {
  organizedCountAtLastConsolidate: number;
  classifyCommitCount: number;
  organizeCommitCount: number;
}

export interface IScanProposalStore {
  savePending(type: ScanType, proposal: UnifiedProposal): Promise<void>;
  getPending(type: ScanType): Promise<ScanProposalRecord | null>;
  markCommitted(type: ScanType): Promise<void>;
  getScanState(): Promise<ScanState>;
  updateScanState(state: Partial<ScanState>): Promise<void>;
  incrementCommitCount(type: 'classify' | 'organize'): Promise<number>; // returns new value
}
