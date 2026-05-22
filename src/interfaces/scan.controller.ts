import type { NoteGraphUseCase } from '../application/graph/graph.usecase';
import type { ClassifyScanUseCase } from '../application/scans/classify/classify.usecase';
import type { ConsolidateScanUseCase } from '../application/scans/consolidate/consolidate.usecase';
import type { OrganizeScanUseCase } from '../application/scans/organize/organize.usecase';
import type { ScanOrchestrator } from '../application/scans/pipeline/scan.orchestrator';
import type { ScanPipeline } from '../application/scans/pipeline/scan.pipeline';
import type { IUserConfigRepository } from '../domain/config/config.types';
import type { IScanProposalStore } from '../domain/scan/scan.state';
import { collectCalibration } from '../domain/scan/scan.thresholds';
import type { UnifiedProposal } from '../domain/scan/unified.proposal';

export class ScanController {
  private vaultSync?: () => Promise<void>;

  constructor(
    private classifyScanUseCase: ClassifyScanUseCase,
    private organizeScanUseCase: OrganizeScanUseCase,
    private noteGraphUseCase: NoteGraphUseCase,
    private consolidateScanUseCase: ConsolidateScanUseCase,
    private proposalStore: IScanProposalStore,
    private orchestrator: ScanOrchestrator,
    private configRepository: IUserConfigRepository,
    private pipeline: ScanPipeline,
  ) {}

  setVaultSync(fn: () => Promise<void>): void {
    this.vaultSync = fn;
  }

  async getStatus() {
    try {
      const [classify, organize, consolidate] = await Promise.all([
        this.proposalStore.getPending('classify'),
        this.proposalStore.getPending('organize'),
        this.proposalStore.getPending('consolidate'),
      ]);
      const [noteCounts, scanState, config] = await Promise.all([
        this.orchestrator.getNoteCounts(),
        this.proposalStore.getScanState(),
        this.configRepository.get(),
      ]);
      const { classifyEvery, organizeAfterClassifies, consolidateAfterOrganizes } =
        config.pipelineConfig;
      return Response.json({
        counts: {
          pending: noteCounts.pending,
          processed: noteCounts.processed,
          scanned: noteCounts.scanned,
          organized: noteCounts.organized,
          failed: noteCounts.failed,
        },
        pipeline: {
          running: this.pipeline.isRunning(),
          config: config.pipelineConfig,
          classifyCommitCount: scanState.classifyCommitCount,
          organizeCommitCount: scanState.organizeCommitCount,
        },
        thresholds: {
          classify: {
            required: classifyEvery,
            current: noteCounts.processed,
            ready: noteCounts.processed >= classifyEvery,
            pendingProposal: !!classify,
          },
          organize: {
            classifyCommitCount: scanState.classifyCommitCount,
            organizeAfterClassifies,
            pendingProposal: !!organize,
          },
          consolidate: {
            organizeCommitCount: scanState.organizeCommitCount,
            consolidateAfterOrganizes,
            pendingProposal: !!consolidate,
          },
        },
        classify: { pending: !!classify, proposal: classify?.proposal ?? null },
        organize: { pending: !!organize, proposal: organize?.proposal ?? null },
        consolidate: { pending: !!consolidate, proposal: consolidate?.proposal ?? null },
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return Response.json({ error: message }, { status: 500 });
    }
  }

  async runClassify() {
    try {
      const existing = await this.proposalStore.getPending('classify');
      if (existing) return Response.json({ status: 'pending_proposal_exists' }, { status: 409 });
      if (this.pipeline.isRunning())
        return Response.json({ status: 'pipeline_busy' }, { status: 409 });
      this.pipeline.enqueue('classify');
      return Response.json({ status: 'enqueued' }, { status: 202 });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return Response.json({ error: message }, { status: 500 });
    }
  }

  async commitClassify(req: Request) {
    try {
      let proposal: UnifiedProposal | null = null;

      try {
        const body = (await req.json()) as { proposal?: UnifiedProposal };
        if (body?.proposal && Array.isArray(body.proposal.assignments)) {
          proposal = body.proposal;
        }
      } catch {
        // empty body or invalid JSON — will use stored proposal
      }

      if (!proposal) {
        const record = await this.proposalStore.getPending('classify');
        if (!record) {
          return Response.json(
            {
              error:
                'No pending classify proposal. Run POST /scan/classify first or wait for volume threshold.',
            },
            { status: 400 },
          );
        }
        proposal = record.proposal;
      }

      const result = await this.classifyScanUseCase.commit(proposal);
      await this.proposalStore.markCommitted('classify');
      const classifiedNoteIds = proposal.assignments.map((a) => a.noteId);
      await this.orchestrator.onClassifyCommit(classifiedNoteIds);
      this.vaultSync?.().catch(() => {});
      return Response.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return Response.json({ error: message }, { status: 500 });
    }
  }

  async runOrganize() {
    try {
      const existing = await this.proposalStore.getPending('organize');
      if (existing) return Response.json({ status: 'pending_proposal_exists' }, { status: 409 });
      if (this.pipeline.isRunning())
        return Response.json({ status: 'pipeline_busy' }, { status: 409 });
      this.pipeline.enqueue('organize');
      return Response.json({ status: 'enqueued' }, { status: 202 });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return Response.json({ error: message }, { status: 500 });
    }
  }

  async commitOrganize(req: Request) {
    try {
      let proposal: UnifiedProposal | null = null;

      try {
        const body = (await req.json()) as { proposal?: UnifiedProposal };
        if (body?.proposal && Array.isArray(body.proposal.splits)) {
          proposal = body.proposal;
        }
      } catch {
        // empty body — will use stored proposal
      }

      if (!proposal) {
        const record = await this.proposalStore.getPending('organize');
        if (!record) {
          return Response.json(
            {
              error:
                'No pending organize proposal. Run POST /scan/organize first or wait for volume threshold.',
            },
            { status: 400 },
          );
        }
        proposal = record.proposal;
      }

      const result = await this.organizeScanUseCase.commit(proposal);
      await this.proposalStore.markCommitted('organize');
      await this.orchestrator.onOrganizeCommit();
      this.vaultSync?.().catch(() => {});
      return Response.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return Response.json({ error: message }, { status: 500 });
    }
  }

  async runGraph() {
    try {
      const result = await this.noteGraphUseCase.build();
      return Response.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return Response.json({ error: message }, { status: 500 });
    }
  }

  async runConsolidate() {
    try {
      const existing = await this.proposalStore.getPending('consolidate');
      if (existing) return Response.json({ status: 'pending_proposal_exists' }, { status: 409 });
      if (this.pipeline.isRunning())
        return Response.json({ status: 'pipeline_busy' }, { status: 409 });
      this.pipeline.enqueue('consolidate');
      return Response.json({ status: 'enqueued' }, { status: 202 });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return Response.json({ error: message }, { status: 500 });
    }
  }

  async commitConsolidate(req: Request) {
    try {
      let proposal: UnifiedProposal | null = null;

      try {
        const body = (await req.json()) as { proposal?: UnifiedProposal };
        if (body?.proposal && Array.isArray(body.proposal.splits)) {
          proposal = body.proposal;
        }
      } catch {
        // empty body — will use stored proposal
      }

      if (!proposal) {
        const record = await this.proposalStore.getPending('consolidate');
        if (!record) {
          return Response.json(
            {
              error:
                'No pending consolidate proposal. Run POST /scan/consolidate first or wait for volume threshold.',
            },
            { status: 400 },
          );
        }
        proposal = record.proposal;
      }

      const result = await this.consolidateScanUseCase.commit(proposal);
      await this.proposalStore.markCommitted('consolidate');
      await this.orchestrator.onConsolidateCommit();
      this.vaultSync?.().catch(() => {});
      return Response.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return Response.json({ error: message }, { status: 500 });
    }
  }

  async getCalibration() {
    try {
      const config = await this.configRepository.get();
      return Response.json(collectCalibration(config));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return Response.json({ error: message }, { status: 500 });
    }
  }
}
