import type { IUserConfigRepository } from '../../../domain/config/config.types';
import type { INoteRepository } from '../../../domain/note/note.entity';
import type { INoteProcessedCallback } from '../../../domain/note/note.processing';
import type { IScanProposalStore } from '../../../domain/scan/scan.state';
import { emptyUnifiedProposal } from '../../../domain/scan/unified.proposal';
import { logger } from '../../../infrastructure/logger';
import type { NoteGraphUseCase } from '../../graph/graph.usecase';
import type { OrganizeScanUseCase } from '../organize/organize.usecase';
import type { PipelineJobType, ScanPipeline } from './scan.pipeline';

const log = logger.child('Orchestrator');

export class ScanOrchestrator implements INoteProcessedCallback {
  constructor(
    private noteRepository: INoteRepository,
    private proposalStore: IScanProposalStore,
    private configRepository: IUserConfigRepository,
    private pipeline: ScanPipeline,
    private noteGraphUseCase: NoteGraphUseCase,
    private organizeUseCase: OrganizeScanUseCase,
  ) {
    // When a job finishes without producing a proposal (null result),
    // treat it as a noop commit so the pipeline doesn't stall.
    this.pipeline.onJobComplete = (job) => {
      this._handleNoopCompletion(job).catch((err) =>
        log.error('Completion handler failed', {
          job,
          err: err instanceof Error ? err : new Error(String(err)),
        }),
      );
    };
  }

  /** If a job completed but produced no pending proposal, advance as if it were committed. */
  private async _handleNoopCompletion(job: PipelineJobType): Promise<void> {
    const pending = await this.proposalStore.getPending(job);
    if (pending) return; // proposal was stored — wait for user commit as normal

    log.info('No proposal generated, advancing pipeline', { job });

    if (job === 'classify') {
      // No classify proposal means no notes matched. Just check for more work.
      await this.checkAndAdvance();
    } else if (job === 'organize') {
      // Organize found nothing to do — commit an empty proposal to finalize scanned notes.
      const scanned = await this.noteRepository.findByStatus('scanned');
      const noteIdsRead = scanned.map((n) => n.id);
      const result = await this.organizeUseCase.commit(emptyUnifiedProposal(), noteIdsRead);
      if (result.notesFinalized > 0)
        log.info('No organize proposal, finalized scanned notes via commit', {
          count: result.notesFinalized,
        });
      await this.onOrganizeCommit();
    } else if (job === 'consolidate') {
      // Consolidate found nothing — advance to next classify cycle.
      await this.onConsolidateCommit();
    }
  }

  // Called by NoteProcessor after each note is processed
  async checkAndAdvance(): Promise<void> {
    const existing = await this.proposalStore.getPending('classify');
    if (existing) return; // proposal already pending, wait for commit
    if (this.pipeline.isRunning()) return; // already generating

    // Don't enqueue more classifies while organize or consolidate await commit
    const orgPending = await this.proposalStore.getPending('organize');
    const conPending = await this.proposalStore.getPending('consolidate');
    if (orgPending || conPending) return;

    const config = await this.configRepository.get();
    const processed = await this.noteRepository.findByStatus('processed');
    if (processed.length >= config.pipelineConfig.classifyEvery) {
      log.info('Classify queued', {
        processed: processed.length,
        threshold: config.pipelineConfig.classifyEvery,
      });
      this.pipeline.enqueue('classify');
    }
  }

  // Called after classify commit (by controller)
  async onClassifyCommit(classifiedNoteIds?: string[]): Promise<void> {
    // Incrementally update the semantic graph for newly classified notes
    if (classifiedNoteIds && classifiedNoteIds.length > 0) {
      this.noteGraphUseCase.buildIncremental(classifiedNoteIds).catch((err) =>
        log.error('Incremental graph update failed', {
          err: err instanceof Error ? err : new Error(String(err)),
        }),
      );
    }

    const count = await this.proposalStore.incrementCommitCount('classify');
    const config = await this.configRepository.get();
    const { organizeAfterClassifies } = config.pipelineConfig;

    if (count % organizeAfterClassifies !== 0) {
      // Check if there are still processed notes for another classify wave
      const existing = await this.proposalStore.getPending('classify');
      if (!existing && !this.pipeline.isRunning()) {
        const processed = await this.noteRepository.findByStatus('processed');
        if (processed.length >= config.pipelineConfig.classifyEvery) {
          log.info('Threshold reached, queuing next classify');
          this.pipeline.enqueue('classify');
        }
      }
      return;
    }

    // Time for organize
    const existing = await this.proposalStore.getPending('organize');
    if (existing || this.pipeline.isRunning()) return;
    log.info('Organize queued', { classifyCommits: count });
    this.pipeline.enqueue('organize');
  }

  // Called after organize commit (by controller)
  async onOrganizeCommit(): Promise<void> {
    const count = await this.proposalStore.incrementCommitCount('organize');
    const config = await this.configRepository.get();
    const { consolidateAfterOrganizes } = config.pipelineConfig;

    if (count % consolidateAfterOrganizes !== 0) {
      await this.checkAndAdvance();
      return;
    }

    const existing = await this.proposalStore.getPending('consolidate');
    if (existing || this.pipeline.isRunning()) return;
    log.info('Consolidate queued', { organizeCommits: count });
    this.pipeline.enqueue('consolidate');
  }

  getNoteCounts(): ReturnType<INoteRepository['countAllStatuses']> {
    return this.noteRepository.countAllStatuses();
  }

  // Called after consolidate commit (by controller)
  async onConsolidateCommit(): Promise<void> {
    const organized = await this.noteRepository.findByStatus('organized');
    await this.proposalStore.updateScanState({ organizedCountAtLastConsolidate: organized.length });
    await this.checkAndAdvance();
  }

  // INoteProcessedCallback — called by NoteProcessor after a note finishes processing
  async onNoteProcessed(): Promise<void> {
    return this.checkAndAdvance();
  }
}
