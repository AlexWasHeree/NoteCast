import type { GetConfigUseCase, UpdateConfigUseCase } from '../application/config/config.usecase';
import type { ResetUseCase } from '../application/config/reset.usecase';
import {
  validateDefaultProvider,
  validateLanguage,
  validateLlmConfig,
  validatePipelineConfig,
  validateThemeStyle,
  validateVaultLinks,
} from '../domain/config/config.validation';
import type { Language } from '../domain/llm/prompts';

export class ConfigController {
  constructor(
    private getConfigUseCase: GetConfigUseCase,
    private updateConfigUseCase: UpdateConfigUseCase,
    private resetUseCase: ResetUseCase,
    private getAvailableProviders: () => readonly string[] = () => [],
    private syncVault?: () => Promise<void>,
  ) {}

  async getConfig() {
    try {
      const result = await this.getConfigUseCase.execute();
      return Response.json(result);
    } catch (err: unknown) {
      return Response.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 500 },
      );
    }
  }

  async updateConfig(req: Request) {
    try {
      const body = (await req.json()) as Record<string, unknown>;

      const errors: string[] = [];
      const warnings: string[] = [];

      if (body.themeStyle !== undefined) {
        const err = validateThemeStyle(body.themeStyle);
        if (err) errors.push(err);
      }

      if (body.pipelineConfig !== undefined) {
        errors.push(...validatePipelineConfig(body.pipelineConfig));
      }

      if (body.llmConfig !== undefined) {
        const result = validateLlmConfig(body.llmConfig, this.getAvailableProviders());
        errors.push(...result.errors);
        warnings.push(...result.warnings);
      }

      if (body.language !== undefined) {
        const err = validateLanguage(body.language);
        if (err) errors.push(err);
      }

      if (body.defaultProvider !== undefined && body.defaultProvider !== null) {
        const err = validateDefaultProvider(body.defaultProvider);
        if (err) errors.push(err);
      }

      if (body.vaultLinks !== undefined) {
        const err = validateVaultLinks(body.vaultLinks);
        if (err) errors.push(err);
      }

      if (errors.length > 0) {
        return Response.json({ errors }, { status: 400 });
      }

      const result = await this.updateConfigUseCase.execute({
        ...(body.themeStyle !== undefined
          ? {
              themeStyle: body.themeStyle as Parameters<
                UpdateConfigUseCase['execute']
              >[0]['themeStyle'],
            }
          : {}),
        ...(body.themeStyleInstruction !== undefined
          ? { themeStyleInstruction: body.themeStyleInstruction as string }
          : {}),
        ...(body.baseThemes !== undefined
          ? { baseThemes: body.baseThemes as { name: string; description?: string }[] }
          : {}),
        ...(body.context !== undefined ? { context: body.context as string } : {}),
        ...(body.pipelineConfig !== undefined
          ? {
              pipelineConfig: body.pipelineConfig as Parameters<
                UpdateConfigUseCase['execute']
              >[0]['pipelineConfig'],
            }
          : {}),
        ...(body.language !== undefined ? { language: body.language as Language } : {}),
        ...(body.vaultPath !== undefined ? { vaultPath: body.vaultPath as string } : {}),
        ...(body.vaultLinks !== undefined ? { vaultLinks: body.vaultLinks as boolean } : {}),
        ...(body.llmConfig !== undefined
          ? {
              llmConfig: body.llmConfig as Parameters<
                UpdateConfigUseCase['execute']
              >[0]['llmConfig'],
            }
          : {}),
        ...(body.defaultProvider !== undefined
          ? {
              defaultProvider: body.defaultProvider as Parameters<
                UpdateConfigUseCase['execute']
              >[0]['defaultProvider'],
            }
          : {}),
      });

      if (this.syncVault && body.vaultPath !== undefined) {
        this.syncVault().catch(() => {});
      }

      if (warnings.length > 0) {
        return Response.json({ ...result, warnings });
      }
      return Response.json(result);
    } catch (err: unknown) {
      return Response.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 500 },
      );
    }
  }

  async reset(req: Request) {
    try {
      let full = false;
      try {
        const body = (await req.json()) as { full?: boolean };
        full = body.full === true;
      } catch {
        // empty body — default to soft reset
      }
      const result = await this.resetUseCase.execute(full);
      return Response.json(result);
    } catch (err: unknown) {
      return Response.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 500 },
      );
    }
  }
}
