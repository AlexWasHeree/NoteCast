import type { LLMProvider } from '../llm/llm.types';

const VALID_LLM_PROVIDERS: readonly LLMProvider[] = [
  'ollama',
  'codex',
  'openai',
  'anthropic',
  'gemini',
  'deepseek',
];

const VALID_THEME_STYLES = ['single-word', 'short-phrase', 'descriptive', 'custom'] as const;

const LLM_STEP_KEYS = ['summary', 'classify', 'organize', 'consolidate'] as const;

export interface ConfigValidationResult {
  errors: string[];
  warnings: string[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateStepLLMConfig(
  key: string,
  raw: unknown,
  availableProviders: readonly string[],
  errors: string[],
  warnings: string[],
) {
  if (!isObject(raw)) {
    errors.push(`llmConfig.${key}: must be an object`);
    return;
  }
  const { provider, model, temperature, maxTokens } = raw;
  if (provider === undefined) {
    errors.push(`llmConfig.${key}.provider: required`);
  } else if (!VALID_LLM_PROVIDERS.includes(provider as LLMProvider)) {
    errors.push(
      `llmConfig.${key}.provider: "${provider}" is not valid. Must be one of: ${VALID_LLM_PROVIDERS.join(', ')}`,
    );
  } else if (!availableProviders.includes(provider as string)) {
    warnings.push(
      `llmConfig.${key}.provider: "${provider}" is not currently available (no credentials found)`,
    );
  }
  if (model !== undefined && typeof model !== 'string') {
    errors.push(`llmConfig.${key}.model: must be a string`);
  }
  if (temperature !== undefined) {
    if (typeof temperature !== 'number' || temperature < 0 || temperature > 1) {
      errors.push(`llmConfig.${key}.temperature: must be a number between 0 and 1`);
    }
  }
  if (maxTokens !== undefined) {
    if (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens) || maxTokens < 1) {
      errors.push(`llmConfig.${key}.maxTokens: must be a positive integer`);
    }
  }
}

function validateStepEmbeddingConfig(
  raw: unknown,
  availableProviders: readonly string[],
  errors: string[],
  warnings: string[],
) {
  if (!isObject(raw)) {
    errors.push('llmConfig.embedding: must be an object');
    return;
  }
  const { provider, model } = raw;
  if (provider !== undefined) {
    if (!VALID_LLM_PROVIDERS.includes(provider as LLMProvider)) {
      errors.push(
        `llmConfig.embedding.provider: "${provider}" is not valid. Must be one of: ${VALID_LLM_PROVIDERS.join(', ')}`,
      );
    } else if (provider !== 'ollama' && !availableProviders.includes(provider as string)) {
      warnings.push(
        `llmConfig.embedding.provider: "${provider}" is not currently available (no credentials found)`,
      );
    }
  }
  if (model !== undefined && typeof model !== 'string') {
    errors.push('llmConfig.embedding.model: must be a string');
  }
}

export function validateLlmConfig(
  raw: unknown,
  availableProviders: readonly string[],
): ConfigValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (raw === undefined || raw === null) return { errors, warnings };
  if (!isObject(raw)) {
    errors.push('llmConfig: must be an object');
    return { errors, warnings };
  }

  const knownKeys = [...LLM_STEP_KEYS, 'embedding'];
  for (const key of Object.keys(raw)) {
    if (!knownKeys.includes(key)) {
      errors.push(`llmConfig: unknown key "${key}". Valid keys: ${knownKeys.join(', ')}`);
    }
  }

  for (const key of LLM_STEP_KEYS) {
    if (raw[key] !== undefined) {
      validateStepLLMConfig(key, raw[key], availableProviders, errors, warnings);
    }
  }

  if (raw.embedding !== undefined) {
    validateStepEmbeddingConfig(raw.embedding, availableProviders, errors, warnings);
  }

  return { errors, warnings };
}

export function validateDefaultProvider(raw: unknown): string | null {
  if (!VALID_LLM_PROVIDERS.includes(raw as LLMProvider)) {
    return `defaultProvider: "${raw}" is not valid. Must be one of: ${VALID_LLM_PROVIDERS.join(', ')}`;
  }
  return null;
}

export function validateThemeStyle(raw: unknown): string | null {
  if (!VALID_THEME_STYLES.includes(raw as (typeof VALID_THEME_STYLES)[number])) {
    return `themeStyle: "${raw}" is not valid. Must be one of: ${VALID_THEME_STYLES.join(', ')}`;
  }
  return null;
}

const VALID_LANGUAGES = ['portuguese', 'english'] as const;

export function validateLanguage(raw: unknown): string | null {
  if (!VALID_LANGUAGES.includes(raw as (typeof VALID_LANGUAGES)[number])) {
    return `language: "${raw}" is not valid. Must be one of: ${VALID_LANGUAGES.join(', ')}`;
  }
  return null;
}

export function validatePipelineConfig(raw: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(raw)) {
    errors.push('pipelineConfig: must be an object');
    return errors;
  }
  const intFields: (keyof typeof raw)[] = [
    'classifyEvery',
    'organizeAfterClassifies',
    'consolidateAfterOrganizes',
  ];
  for (const field of intFields) {
    const v = raw[field];
    if (v !== undefined && (typeof v !== 'number' || !Number.isInteger(v) || (v as number) < 1)) {
      errors.push(`pipelineConfig.${field}: must be a positive integer`);
    }
  }
  return errors;
}

export function validateVaultLinks(raw: unknown): string | null {
  if (typeof raw !== 'boolean') {
    return 'vaultLinks: must be a boolean';
  }
  return null;
}
