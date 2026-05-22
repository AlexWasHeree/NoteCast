import type {
  IUserConfigRepository,
  Language,
  LLMProvider,
  PipelineConfig,
  UserConfig,
} from '../../domain/config/config.types';
import type { IEmbeddingClient } from '../../domain/llm/llm.types';
import type { IThemeRepository, Theme } from '../../domain/theme/theme.entity';
import { newId } from '../../infrastructure/id';
import { logger } from '../../infrastructure/logger';

const log = logger.child('Config');

export class GetConfigUseCase {
  constructor(private configRepository: IUserConfigRepository) {}

  async execute(): Promise<{ config: UserConfig; context: string }> {
    const config = await this.configRepository.get();
    return { config, context: config.context ?? '' };
  }
}

export class UpdateConfigUseCase {
  constructor(
    private configRepository: IUserConfigRepository,
    private themeRepository: IThemeRepository,
    private embeddingClient?: IEmbeddingClient,
  ) {}

  async execute(input: {
    themeStyle?: UserConfig['themeStyle'];
    themeStyleInstruction?: string;
    baseThemes?: { name: string; description?: string }[];
    context?: string;
    pipelineConfig?: Partial<PipelineConfig>;
    language?: Language;
    defaultProvider?: LLMProvider | null;
    llmConfig?: UserConfig['llmConfig'];
    vaultPath?: string;
    vaultLinks?: boolean;
  }): Promise<UserConfig> {
    const current = await this.configRepository.get();

    const updated: UserConfig = {
      themeStyle: input.themeStyle ?? current.themeStyle,
      baseThemes: input.baseThemes ?? current.baseThemes,
      pipelineConfig: {
        ...current.pipelineConfig,
        ...(input.pipelineConfig ?? {}),
      },
      language: input.language ?? current.language,
    };
    if (input.llmConfig !== undefined) {
      updated.llmConfig = input.llmConfig;
    } else if (current.llmConfig !== undefined) {
      updated.llmConfig = current.llmConfig;
    }
    if (input.themeStyleInstruction !== undefined) {
      updated.themeStyleInstruction = input.themeStyleInstruction;
    } else if (current.themeStyleInstruction !== undefined) {
      updated.themeStyleInstruction = current.themeStyleInstruction;
    }
    if (input.context !== undefined) {
      updated.context = input.context;
    } else if (current.context !== undefined) {
      updated.context = current.context;
    }
    if (input.vaultPath !== undefined) {
      updated.vaultPath = input.vaultPath;
    } else if (current.vaultPath !== undefined) {
      updated.vaultPath = current.vaultPath;
    }
    if (input.vaultLinks !== undefined) {
      updated.vaultLinks = input.vaultLinks;
    } else if (current.vaultLinks !== undefined) {
      updated.vaultLinks = current.vaultLinks;
    }
    if (input.defaultProvider !== undefined) {
      if (input.defaultProvider !== null) updated.defaultProvider = input.defaultProvider;
    } else if (current.defaultProvider !== undefined) {
      updated.defaultProvider = current.defaultProvider;
    }

    await this.configRepository.save(updated);

    // Sync base themes: upsert by name (create if not exists, update description vector if changed)
    for (const bt of updated.baseThemes) {
      const existing = await this.themeRepository.findByName(bt.name);
      if (!existing) {
        const theme: Theme = {
          id: newId(),
          name: bt.name,
          noteIds: [],
          parentIds: [],
          createdAt: new Date(),
        };
        if (bt.description) {
          theme.description = bt.description;
          const vec = await this._embedDescription(bt.description);
          if (vec) theme.descriptionVector = vec;
        }
        await this.themeRepository.save(theme);
      } else if (bt.description && bt.description !== existing.description) {
        // Description changed — recompute vector
        const vec = await this._embedDescription(bt.description);
        await this.themeRepository.update({
          ...existing,
          description: bt.description,
          ...(vec ? { descriptionVector: vec } : {}),
        });
      } else if (bt.description && !existing.descriptionVector) {
        // Has description but no vector yet (e.g. created before this feature)
        const vec = await this._embedDescription(bt.description);
        if (vec) {
          await this.themeRepository.update({ ...existing, descriptionVector: vec });
        }
      }
    }
    // Removed base themes are left as regular themes (per spec)

    return updated;
  }

  private async _embedDescription(description: string): Promise<number[] | undefined> {
    if (!this.embeddingClient) return undefined;
    try {
      return await this.embeddingClient.embed(description);
    } catch (err) {
      log.warn('Failed to embed theme description', {
        err: err instanceof Error ? err : new Error(String(err)),
      });
      return undefined;
    }
  }
}
