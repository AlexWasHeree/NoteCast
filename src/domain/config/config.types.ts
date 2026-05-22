import type { LLMProvider } from '../llm/llm.types';

export type { LLMProvider };

import type { Language } from '../llm/prompts';

export type { Language };

export interface StepLLMConfig {
  provider: LLMProvider;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface StepEmbeddingConfig {
  provider?: LLMProvider;
  model?: string;
}

export interface PipelineLLMConfig {
  summary?: StepLLMConfig;
  classify?: StepLLMConfig;
  organize?: StepLLMConfig;
  consolidate?: StepLLMConfig;
  embedding?: StepEmbeddingConfig;
}

export interface PipelineConfig {
  classifyEvery: number; // processed notes to trigger classify (default: 10)
  organizeAfterClassifies: number; // classify commits to trigger organize (default: 2)
  consolidateAfterOrganizes: number; // organize commits to trigger consolidate (default: 3)
}

export interface UserConfig {
  themeStyle: 'single-word' | 'short-phrase' | 'descriptive' | 'custom';
  themeStyleInstruction?: string;
  baseThemes: { name: string; description?: string }[];
  pipelineConfig: PipelineConfig;
  vaultPath?: string;
  vaultLinks?: boolean;
  context?: string;
  language: Language; // keyword-extractor language name
  defaultProvider?: LLMProvider; // explicit default provider for all pipeline steps
  llmConfig?: PipelineLLMConfig; // per-step provider+model overrides; undefined = uses defaultProvider
}

export interface IUserConfigRepository {
  get(): Promise<UserConfig>;
  save(config: UserConfig): Promise<void>;
}

export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  classifyEvery: 10,
  organizeAfterClassifies: 2,
  consolidateAfterOrganizes: 3,
};

export const DEFAULT_USER_CONFIG: UserConfig = {
  themeStyle: 'short-phrase',
  baseThemes: [],
  pipelineConfig: DEFAULT_PIPELINE_CONFIG,
  language: 'english',
  vaultLinks: false,
};
