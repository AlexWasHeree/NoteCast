import { beforeEach, describe, expect, test } from 'bun:test';
import type { IUserConfigRepository, UserConfig } from '../../domain/config/config.types';
import { DEFAULT_USER_CONFIG } from '../../domain/config/config.types';
import { InMemoryThemeRepository } from '../../infrastructure/notes/adapters';
import { GetConfigUseCase, UpdateConfigUseCase } from './config.usecase';

// In-memory config repo for tests
class InMemoryConfigRepository implements IUserConfigRepository {
  private data: UserConfig = { ...DEFAULT_USER_CONFIG };
  async get(): Promise<UserConfig> {
    return { ...this.data };
  }
  async save(config: UserConfig): Promise<void> {
    this.data = { ...config };
  }
}

// --- GetConfigUseCase ---

describe('GetConfigUseCase', () => {
  test('returns default config with empty context', async () => {
    const repo = new InMemoryConfigRepository();
    const useCase = new GetConfigUseCase(repo);
    const result = await useCase.execute();
    expect(result.config.themeStyle).toBe('short-phrase');
    expect(result.context).toBe('');
  });

  test('returns context from config', async () => {
    const repo = new InMemoryConfigRepository();
    await repo.save({ ...(await repo.get()), context: 'my context' });
    const useCase = new GetConfigUseCase(repo);
    const result = await useCase.execute();
    expect(result.context).toBe('my context');
  });
});

// --- UpdateConfigUseCase ---

describe('UpdateConfigUseCase', () => {
  let configRepo: InMemoryConfigRepository;
  let themeRepo: InMemoryThemeRepository;
  beforeEach(() => {
    configRepo = new InMemoryConfigRepository();
    themeRepo = new InMemoryThemeRepository();
  });

  test('updates themeStyle', async () => {
    const useCase = new UpdateConfigUseCase(configRepo, themeRepo);
    const result = await useCase.execute({ themeStyle: 'single-word' });
    expect(result.themeStyle).toBe('single-word');
    const saved = await configRepo.get();
    expect(saved.themeStyle).toBe('single-word');
  });

  test('creates new base themes in theme repository (upsert by name)', async () => {
    const useCase = new UpdateConfigUseCase(configRepo, themeRepo);
    await useCase.execute({ baseThemes: [{ name: 'meu-projeto', description: 'My project' }] });
    const themes = await themeRepo.findAll();
    expect(themes.some((t) => t.name === 'meu-projeto')).toBe(true);
  });

  test('does not duplicate theme if base theme name already exists', async () => {
    const useCase = new UpdateConfigUseCase(configRepo, themeRepo);
    await useCase.execute({ baseThemes: [{ name: 'meu-projeto' }] });
    await useCase.execute({ baseThemes: [{ name: 'meu-projeto' }] });
    const themes = await themeRepo.findAll();
    expect(themes.filter((t) => t.name === 'meu-projeto')).toHaveLength(1);
  });

  test('removed base theme is NOT deleted from theme repo', async () => {
    const useCase = new UpdateConfigUseCase(configRepo, themeRepo);
    await useCase.execute({ baseThemes: [{ name: 'will-be-removed' }] });
    await useCase.execute({ baseThemes: [] });
    const themes = await themeRepo.findAll();
    expect(themes.some((t) => t.name === 'will-be-removed')).toBe(true);
  });

  test('saves context to config when provided', async () => {
    const useCase = new UpdateConfigUseCase(configRepo, themeRepo);
    await useCase.execute({ context: 'My context text' });
    const saved = await configRepo.get();
    expect(saved.context).toBe('My context text');
  });

  test('preserves existing fields when only partial update provided', async () => {
    const useCase = new UpdateConfigUseCase(configRepo, themeRepo);
    await useCase.execute({ themeStyle: 'descriptive', baseThemes: [{ name: 'Theme A' }] });
    const result = await useCase.execute({ themeStyle: 'single-word' });
    expect(result.baseThemes).toHaveLength(1);
    expect(result.baseThemes[0]?.name).toBe('Theme A');
  });

  test('saves and retrieves full StepLLMConfig with temperature and maxTokens', async () => {
    const useCase = new UpdateConfigUseCase(configRepo, themeRepo);
    await useCase.execute({
      llmConfig: {
        classify: { provider: 'openai', model: 'gpt-4o', temperature: 0.1, maxTokens: 500 },
      },
    });
    const saved = await configRepo.get();
    expect(saved.llmConfig?.classify).toEqual({
      provider: 'openai',
      model: 'gpt-4o',
      temperature: 0.1,
      maxTokens: 500,
    });
  });

  test('persists vaultLinks: false', async () => {
    const repo = new InMemoryConfigRepository();
    const themeRepo = new InMemoryThemeRepository();
    const useCase = new UpdateConfigUseCase(repo, themeRepo);

    await useCase.execute({ vaultLinks: false });

    const { config } = await new GetConfigUseCase(repo).execute();
    expect(config.vaultLinks).toBe(false);
  });

  test('persists vaultLinks: true', async () => {
    const repo = new InMemoryConfigRepository();
    const themeRepo = new InMemoryThemeRepository();
    const useCase = new UpdateConfigUseCase(repo, themeRepo);

    await useCase.execute({ vaultLinks: true });

    const { config } = await new GetConfigUseCase(repo).execute();
    expect(config.vaultLinks).toBe(true);
  });
});
