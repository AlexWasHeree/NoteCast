import type { IUserConfigRepository } from '../../domain/config/config.types';
import type { IEmbeddingClient } from '../../domain/llm/llm.types';
import type { INoteRepository } from '../../domain/note/note.entity';
import type { IScanProposalStore } from '../../domain/scan/scan.state';
import type { IThemeRepository, Theme } from '../../domain/theme/theme.entity';
import { newId } from '../../infrastructure/id';
import { logger } from '../../infrastructure/logger';
import type { IQueueProvider } from '../notes/note.usecase';

const log = logger.child('Reset');

export class ResetUseCase {
  constructor(
    private noteRepository: INoteRepository,
    private themeRepository: IThemeRepository,
    private proposalStore: IScanProposalStore,
    private configRepository: IUserConfigRepository,
    private queueProvider: IQueueProvider,
    private embeddingClient?: IEmbeddingClient,
  ) {}

  async execute(full: boolean = false): Promise<{ notesReset: number; themesDeleted: number }> {
    // 1. Delete all themes (single transaction)
    const themesDeleted = await this.themeRepository.deleteAll();

    // 2. Reset notes — full deletes, soft re-queues scanned/organized back to processed
    const { count: notesReset, noteIds } = await this.noteRepository.resetAll(full);
    if (!full) {
      for (const id of noteIds) {
        await this.queueProvider.enqueue(id);
      }
    }

    // 3. Discard all pending proposals
    await this.proposalStore.markCommitted('classify');
    await this.proposalStore.markCommitted('organize');
    await this.proposalStore.markCommitted('consolidate');

    // 4. Reset scan_state (commit counters always, organized count only on full)
    if (full) {
      await this.proposalStore.updateScanState({
        organizedCountAtLastConsolidate: 0,
        classifyCommitCount: 0,
        organizeCommitCount: 0,
      });
    } else {
      await this.proposalStore.updateScanState({
        classifyCommitCount: 0,
        organizeCommitCount: 0,
      });
    }

    // 5. Recreate base themes from config (with descriptionVector)
    const config = await this.configRepository.get();
    for (const bt of config.baseThemes) {
      const theme: Theme = {
        id: newId(),
        name: bt.name,
        noteIds: [],
        parentIds: [],
        createdAt: new Date(),
      };
      if (bt.description) {
        theme.description = bt.description;
        if (this.embeddingClient) {
          try {
            theme.descriptionVector = await this.embeddingClient.embed(bt.description);
          } catch (err) {
            log.warn('Failed to embed description', {
              theme: bt.name,
              err: err instanceof Error ? err : new Error(String(err)),
            });
          }
        }
      }
      await this.themeRepository.save(theme);
    }

    return { notesReset, themesDeleted };
  }
}
