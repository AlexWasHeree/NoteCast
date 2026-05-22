import type { IScanProposalStore } from '../../../domain/scan/scan.state';
import { logger } from '../../../infrastructure/logger';
import type { NoteGraphUseCase } from '../../graph/graph.usecase';
import type { ClassifyScanUseCase } from '../classify/classify.usecase';
import type { ConsolidateScanUseCase } from '../consolidate/consolidate.usecase';
import type { OrganizeScanUseCase } from '../organize/organize.usecase';

const log = logger.child('Pipeline');

export type PipelineJobType = 'classify' | 'organize' | 'consolidate';

interface IVaultProposalSaver {
  saveProposal(type: PipelineJobType, proposal: unknown): Promise<string | null>;
}

export class ScanPipeline {
  private queue: PipelineJobType[] = [];
  private running = false;
  private currentJob: PipelineJobType | null = null;
  private drainPromise: Promise<void> | null = null;
  private vaultSyncer?: IVaultProposalSaver;
  public onJobComplete?: (job: PipelineJobType) => void;

  setVaultSyncer(syncer: IVaultProposalSaver): void {
    this.vaultSyncer = syncer;
  }

  constructor(
    private classifyScanUseCase: ClassifyScanUseCase,
    private organizeScanUseCase: OrganizeScanUseCase,
    private consolidateScanUseCase: ConsolidateScanUseCase,
    private noteGraphUseCase: NoteGraphUseCase,
    private proposalStore: IScanProposalStore,
  ) {}

  enqueue(job: PipelineJobType): void {
    // Deduplicate: ignore if already queued or currently running
    if (this.queue.includes(job) || this.currentJob === job) return;
    this.queue.push(job);
    if (!this.running) {
      this.drainPromise = this._drain().catch((err) =>
        log.error('Pipeline flush failed', {
          err: err instanceof Error ? err : new Error(String(err)),
        }),
      );
    }
  }

  isRunning(): boolean {
    return this.running || this.queue.length > 0;
  }

  async waitForIdle(): Promise<void> {
    if (this.drainPromise) await this.drainPromise;
  }

  private async _drain(): Promise<void> {
    this.running = true;
    while (this.queue.length > 0) {
      this.currentJob = this.queue.shift()!;
      try {
        await this._execute(this.currentJob);
        this.onJobComplete?.(this.currentJob);
      } catch (err) {
        log.error('Scan job failed', {
          job: this.currentJob,
          err: err instanceof Error ? err : new Error(String(err)),
        });
      } finally {
        this.currentJob = null;
      }
    }
    this.running = false;
  }

  private async _execute(job: PipelineJobType): Promise<void> {
    const done = log.time(`scan.${job}`);
    log.info('Scan job starting', { job });
    let result: string = 'no_proposal';
    try {
      if (job === 'classify') {
        const r = await this.classifyScanUseCase.execute();
        if (r.unifiedProposal) {
          await this.proposalStore.savePending('classify', r.unifiedProposal);
          await this.vaultSyncer?.saveProposal('classify', r.unifiedProposal);
          result = 'proposal_saved';
        }
      } else if (job === 'organize') {
        const r = await this.organizeScanUseCase.execute();
        if (r.unifiedProposal) {
          await this.proposalStore.savePending('organize', r.unifiedProposal);
          await this.vaultSyncer?.saveProposal('organize', r.unifiedProposal);
          result = 'proposal_saved';
        }
      } else if (job === 'consolidate') {
        await this.noteGraphUseCase.build();
        const unified = await this.consolidateScanUseCase.generateProposal();
        if (unified) {
          await this.proposalStore.savePending('consolidate', unified);
          await this.vaultSyncer?.saveProposal('consolidate', unified);
          result = 'proposal_saved';
        }
      }
    } finally {
      done({ job, result });
    }
  }
}
