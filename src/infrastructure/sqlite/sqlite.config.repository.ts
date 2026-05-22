import type { Database } from 'bun:sqlite';
import type { IUserConfigRepository, UserConfig } from '../../domain/config/config.types';
import { DEFAULT_PIPELINE_CONFIG, DEFAULT_USER_CONFIG } from '../../domain/config/config.types';

export class SQLiteUserConfigRepository implements IUserConfigRepository {
  constructor(private db: Database) {}

  async get(): Promise<UserConfig> {
    const row = this.db.query('SELECT * FROM user_config WHERE id = 1').get() as any;
    if (!row) return { ...DEFAULT_USER_CONFIG };
    return {
      themeStyle: row.theme_style as UserConfig['themeStyle'],
      themeStyleInstruction: row.theme_style_instruction ?? undefined,
      baseThemes: (() => {
        const parsed = row.base_themes ? JSON.parse(row.base_themes) : [];
        if (!Array.isArray(parsed)) return typeof parsed === 'string' ? [{ name: parsed }] : [];
        return parsed as UserConfig['baseThemes'];
      })(),
      pipelineConfig: row.pipeline_config
        ? { ...DEFAULT_PIPELINE_CONFIG, ...JSON.parse(row.pipeline_config) }
        : DEFAULT_PIPELINE_CONFIG,
      vaultPath: row.vault_path ?? undefined,
      vaultLinks: row.vault_links === 1,
      context: row.context ?? undefined,
      language: (row.language ?? DEFAULT_USER_CONFIG.language) as UserConfig['language'],
      ...(row.llm_config
        ? { llmConfig: JSON.parse(row.llm_config) as UserConfig['llmConfig'] }
        : {}),
      ...(row.default_provider
        ? { defaultProvider: row.default_provider as UserConfig['defaultProvider'] }
        : {}),
    } as UserConfig;
  }

  async save(config: UserConfig): Promise<void> {
    this.db.run(
      `INSERT OR REPLACE INTO user_config (id, theme_style, theme_style_instruction, base_themes, pipeline_config, vault_path, vault_links, context, language, llm_config, default_provider, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [
        config.themeStyle,
        config.themeStyleInstruction ?? null,
        JSON.stringify(config.baseThemes),
        JSON.stringify(config.pipelineConfig),
        config.vaultPath ?? null,
        config.vaultLinks === undefined ? null : config.vaultLinks ? 1 : 0,
        config.context ?? null,
        config.language,
        config.llmConfig ? JSON.stringify(config.llmConfig) : null,
        config.defaultProvider ?? null,
      ],
    );
  }
}
