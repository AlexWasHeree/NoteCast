import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StepLLMConfig } from '../../../domain/config/config.types';
import type { ChatOptions, ILLMClient, LLMProvider } from '../../../domain/llm/llm.types';

const tmpHome = join(tmpdir(), `llm-factory-test-${process.pid}`);

function writeCodexAuth(token: string) {
  const dir = join(tmpHome, '.codex');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({ access_token: token }));
}

let originalHome: string | undefined;
const savedEnv: Record<string, string | undefined> = {};
const envKeys = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'DEEPSEEK_API_KEY'];

beforeEach(() => {
  originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
  for (const k of envKeys) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  process.env.HOME = originalHome;
  for (const k of envKeys) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {}
});

describe('detectAvailableProviders', () => {
  test('returns all unavailable when nothing configured', async () => {
    const { detectAvailableProviders } = await import('../clients/llm.factory');
    const result = detectAvailableProviders();
    expect(result.every((p) => !p.available)).toBe(true);
  });

  test('marks openai available when env var set', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const { detectAvailableProviders } = await import('../clients/llm.factory');
    const result = detectAvailableProviders();
    expect(result.find((p) => p.name === 'openai')?.available).toBe(true);
  });

  test('marks codex available when auth.json exists', async () => {
    writeCodexAuth('tok-abc');
    const { detectAvailableProviders } = await import('../clients/llm.factory');
    const result = detectAvailableProviders();
    expect(result.find((p) => p.name === 'codex')?.available).toBe(true);
  });

  test('returns providers in priority order: openai first, codex last', async () => {
    const { detectAvailableProviders } = await import('../clients/llm.factory');
    const result = detectAvailableProviders();
    expect(result[0].name).toBe('openai');
    expect(result[1].name).toBe('anthropic');
    expect(result[4].name).toBe('codex');
  });
});

describe('resolveStepClient', () => {
  function makeRegistry(): Record<LLMProvider, ILLMClient> {
    const makeClient = (): ILLMClient => ({
      async chat(_q: string, _opts?: ChatOptions) {
        return 'response';
      },
    });
    return {
      ollama: makeClient(),
      codex: makeClient(),
      openai: makeClient(),
      anthropic: makeClient(),
      gemini: makeClient(),
      deepseek: makeClient(),
    };
  }

  test('returns registry client directly when no stepConfig', async () => {
    const { resolveStepClient } = await import('../clients/llm.factory');
    const registry = makeRegistry();
    const client = resolveStepClient(registry, 'openai', undefined);
    expect(client).toBe(registry.openai);
  });

  test('returns undefined when no defaultProvider and no stepConfig', async () => {
    const { resolveStepClient } = await import('../clients/llm.factory');
    const registry = makeRegistry();
    const client = resolveStepClient(registry, undefined, undefined);
    expect(client).toBeUndefined();
  });

  test('uses stepConfig.provider even when defaultProvider is undefined', async () => {
    const { resolveStepClient } = await import('../clients/llm.factory');
    const registry = makeRegistry();
    const stepConfig: StepLLMConfig = { provider: 'anthropic' };
    const client = resolveStepClient(registry, undefined, stepConfig);
    expect(client).toBe(registry.anthropic);
  });

  test('uses provider from stepConfig over defaultProvider', async () => {
    const { resolveStepClient } = await import('../clients/llm.factory');
    const registry = makeRegistry();
    const stepConfig: StepLLMConfig = { provider: 'anthropic' };
    const client = resolveStepClient(registry, 'openai', stepConfig);
    expect(client).toBe(registry.anthropic);
  });

  test('returns direct client when stepConfig has only provider (no overrides)', async () => {
    const { resolveStepClient } = await import('../clients/llm.factory');
    const registry = makeRegistry();
    const stepConfig: StepLLMConfig = { provider: 'gemini' };
    const client = resolveStepClient(registry, 'openai', stepConfig);
    expect(client).toBe(registry.gemini);
  });

  test('wraps client and applies model override — config wins over caller', async () => {
    const { resolveStepClient } = await import('../clients/llm.factory');
    const received: string[] = [];
    const registry = makeRegistry();
    registry.openai = {
      async chat(_q, opts) {
        received.push(opts?.model ?? '');
        return 'ok';
      },
    };
    const stepConfig: StepLLMConfig = { provider: 'openai', model: 'gpt-4o' };
    const client = resolveStepClient(registry, 'openai', stepConfig);
    await client.chat('test', { model: 'gpt-3.5' }); // caller default, should be overridden
    expect(received[0]).toBe('gpt-4o');
  });

  test('wraps client and applies temperature override — config wins over caller', async () => {
    const { resolveStepClient } = await import('../clients/llm.factory');
    const received: number[] = [];
    const registry = makeRegistry();
    registry.openai = {
      async chat(_q, opts) {
        received.push(opts?.temperature ?? -1);
        return 'ok';
      },
    };
    const stepConfig: StepLLMConfig = { provider: 'openai', temperature: 0.7 };
    const client = resolveStepClient(registry, 'openai', stepConfig);
    await client.chat('test', { temperature: 0.0 }); // caller default, should be overridden
    expect(received[0]).toBe(0.7);
  });

  test('wraps client and applies maxTokens override — config wins over caller', async () => {
    const { resolveStepClient } = await import('../clients/llm.factory');
    const received: number[] = [];
    const registry = makeRegistry();
    registry.openai = {
      async chat(_q, opts) {
        received.push(opts?.maxTokens ?? -1);
        return 'ok';
      },
    };
    const stepConfig: StepLLMConfig = { provider: 'openai', maxTokens: 1000 };
    const client = resolveStepClient(registry, 'openai', stepConfig);
    await client.chat('test', { maxTokens: 200 }); // caller default, should be overridden
    expect(received[0]).toBe(1000);
  });
});
