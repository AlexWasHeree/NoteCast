import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StepEmbeddingConfig, StepLLMConfig } from '../../../domain/config/config.types';
import type {
  EmbedOptions,
  IEmbeddingClient,
  ILLMClient,
  LLMProvider,
} from '../../../domain/llm/llm.types';
import { getStoredKey } from '../../notes-auth';
import { AnthropicClient } from './anthropic.client';
import { CodexClient } from './codex.client';
import { DeepSeekClient } from './deepseek.client';
import { GeminiClient } from './gemini.client';
import { OllamaClient, OllamaEmbeddingClient } from './ollama.client';
import { OpenAIClient, OpenAIEmbeddingClient } from './openai.client';

export type ApiProviderName = 'codex' | 'openai' | 'anthropic' | 'gemini' | 'deepseek';
export type { LLMProvider };

export interface ProviderStatus {
  name: ApiProviderName;
  available: boolean;
}

function extractToken(obj: unknown): string | null {
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const token = (o.access_token as string) ?? (o.accessToken as string);
  if (typeof token === 'string' && token.length > 0) return token;
  for (const key of ['tokens', 'provider', 'openai', 'session', 'credentials']) {
    const nested = o[key];
    if (nested) {
      const t = extractToken(nested);
      if (t) return t;
    }
  }
  return null;
}

function isCodexAvailable(): boolean {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const paths = [join(home, '.codex', 'auth.json'), join(home, '.codex-auth', 'auth.json')];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      return extractToken(JSON.parse(readFileSync(p, 'utf-8'))) !== null;
    } catch {}
  }
  return false;
}

export function detectAvailableProviders(): ProviderStatus[] {
  return [
    { name: 'openai', available: !!(process.env.OPENAI_API_KEY?.trim() || getStoredKey('openai')) },
    {
      name: 'anthropic',
      available: !!(process.env.ANTHROPIC_API_KEY?.trim() || getStoredKey('anthropic')),
    },
    { name: 'gemini', available: !!(process.env.GEMINI_API_KEY?.trim() || getStoredKey('gemini')) },
    {
      name: 'deepseek',
      available: !!(process.env.DEEPSEEK_API_KEY?.trim() || getStoredKey('deepseek')),
    },
    { name: 'codex', available: isCodexAvailable() },
  ];
}

export function createEmbeddingRegistry(
  ollamaEmbeddingClient: IEmbeddingClient,
): Partial<Record<LLMProvider, IEmbeddingClient>> {
  return {
    ollama: ollamaEmbeddingClient,
    openai: new OpenAIEmbeddingClient(),
  };
}

export function resolveEmbeddingClient(
  registry: Partial<Record<LLMProvider, IEmbeddingClient>>,
  defaultClient: IEmbeddingClient | undefined,
  config?: StepEmbeddingConfig,
  defaultProvider?: LLMProvider,
): IEmbeddingClient | undefined {
  const provider = config?.provider ?? defaultProvider;
  const client = provider ? (registry[provider] ?? defaultClient) : defaultClient;
  if (!client) return undefined;
  if (config?.model === undefined) return client;
  return {
    embed: (text: string, opts?: EmbedOptions) =>
      client.embed(text, { ...opts, model: config.model }),
  };
}

export function createClientRegistry(ollamaClient: ILLMClient): Record<LLMProvider, ILLMClient> {
  return {
    ollama: ollamaClient,
    codex: new CodexClient(),
    openai: new OpenAIClient(),
    anthropic: new AnthropicClient(),
    gemini: new GeminiClient(),
    deepseek: new DeepSeekClient(),
  };
}

export function resolveStepClient(
  registry: Record<LLMProvider, ILLMClient>,
  defaultProvider: LLMProvider | undefined,
  stepConfig?: StepLLMConfig,
): ILLMClient | undefined {
  const provider = stepConfig?.provider ?? defaultProvider;
  if (!provider) return undefined;
  const client = registry[provider];
  const hasOverrides =
    stepConfig?.model !== undefined ||
    stepConfig?.temperature !== undefined ||
    stepConfig?.maxTokens !== undefined;
  if (!hasOverrides) return client;
  return {
    chat: (q, opts) =>
      client.chat(q, {
        ...opts,
        ...(stepConfig?.model !== undefined ? { model: stepConfig.model } : {}),
        ...(stepConfig?.temperature !== undefined ? { temperature: stepConfig.temperature } : {}),
        ...(stepConfig?.maxTokens !== undefined ? { maxTokens: stepConfig.maxTokens } : {}),
      }),
  };
}
