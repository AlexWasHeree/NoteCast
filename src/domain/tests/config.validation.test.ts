import { describe, expect, test } from 'bun:test';
import {
  validateLanguage,
  validateLlmConfig,
  validatePipelineConfig,
  validateThemeStyle,
  validateVaultLinks,
} from '../config/config.validation';

const ALL_PROVIDERS = ['ollama', 'codex', 'openai', 'anthropic', 'gemini', 'deepseek'];

// --- validateLlmConfig ---

describe('validateLlmConfig', () => {
  test('returns no errors for undefined', () => {
    const { errors, warnings } = validateLlmConfig(undefined, ALL_PROVIDERS);
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  test('returns no errors for valid step config', () => {
    const { errors } = validateLlmConfig(
      { classify: { provider: 'openai', model: 'gpt-4o', temperature: 0.1, maxTokens: 500 } },
      ALL_PROVIDERS,
    );
    expect(errors).toHaveLength(0);
  });

  test('error for invalid provider name', () => {
    const { errors } = validateLlmConfig({ classify: { provider: 'gpt-5' } }, ALL_PROVIDERS);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/provider.*gpt-5.*not valid/);
  });

  test('error for missing provider in LLM step', () => {
    const { errors } = validateLlmConfig({ classify: { model: 'gpt-4o' } }, ALL_PROVIDERS);
    expect(errors.some((e) => e.includes('provider') && e.includes('required'))).toBe(true);
  });

  test('error for non-object step value', () => {
    const { errors } = validateLlmConfig({ classify: 'openai' }, ALL_PROVIDERS);
    expect(errors[0]).toMatch(/must be an object/);
  });

  test('error for temperature out of range', () => {
    const { errors } = validateLlmConfig(
      { classify: { provider: 'openai', temperature: 1.5 } },
      ALL_PROVIDERS,
    );
    expect(errors[0]).toMatch(/temperature.*between 0 and 1/);
  });

  test('error for non-integer maxTokens', () => {
    const { errors } = validateLlmConfig(
      { classify: { provider: 'openai', maxTokens: 1.5 } },
      ALL_PROVIDERS,
    );
    expect(errors[0]).toMatch(/maxTokens.*positive integer/);
  });

  test('error for unknown key in llmConfig', () => {
    const { errors } = validateLlmConfig({ unknown_step: { provider: 'openai' } }, ALL_PROVIDERS);
    expect(errors[0]).toMatch(/unknown key.*unknown_step/);
  });

  test('warning when provider not in availableProviders', () => {
    const { errors, warnings } = validateLlmConfig(
      { classify: { provider: 'gemini' } },
      ['openai', 'codex'], // gemini not available
    );
    expect(errors).toHaveLength(0);
    expect(warnings[0]).toMatch(/gemini.*not currently available/);
  });

  test('no warning when ollama configured (always local)', () => {
    const { warnings } = validateLlmConfig({ summary: { provider: 'ollama' } }, [
      'ollama',
      'openai',
    ]);
    expect(warnings).toHaveLength(0);
  });

  test('valid embedding config', () => {
    const { errors } = validateLlmConfig(
      { embedding: { model: 'mxbai-embed-large' } },
      ALL_PROVIDERS,
    );
    expect(errors).toHaveLength(0);
  });

  test('error for embedding model non-string', () => {
    const { errors } = validateLlmConfig({ embedding: { model: 42 } }, ALL_PROVIDERS);
    expect(errors[0]).toMatch(/embedding.model.*string/);
  });

  test('valid embedding config with provider', () => {
    const { errors } = validateLlmConfig(
      { embedding: { provider: 'openai', model: 'text-embedding-3-small' } },
      ALL_PROVIDERS,
    );
    expect(errors).toHaveLength(0);
  });

  test('error for invalid embedding provider', () => {
    const { errors } = validateLlmConfig({ embedding: { provider: 'gpt-5' } }, ALL_PROVIDERS);
    expect(errors[0]).toMatch(/embedding.provider.*gpt-5.*not valid/);
  });

  test('warning when embedding provider not available', () => {
    const { errors, warnings } = validateLlmConfig(
      { embedding: { provider: 'anthropic' } },
      ['openai'], // anthropic not available
    );
    expect(errors).toHaveLength(0);
    expect(warnings[0]).toMatch(/embedding.provider.*anthropic.*not currently available/);
  });

  test('no warning for ollama embedding provider (always local)', () => {
    const { warnings } = validateLlmConfig(
      { embedding: { provider: 'ollama' } },
      ['openai'], // ollama not in available list but should not warn
    );
    expect(warnings).toHaveLength(0);
  });

  test('llmConfig not an object → error', () => {
    const { errors } = validateLlmConfig('openai', ALL_PROVIDERS);
    expect(errors[0]).toMatch(/llmConfig.*must be an object/);
  });
});

// --- validateThemeStyle ---

describe('validateThemeStyle', () => {
  test('accepts valid values', () => {
    for (const v of ['single-word', 'short-phrase', 'descriptive', 'custom']) {
      expect(validateThemeStyle(v)).toBeNull();
    }
  });

  test('rejects invalid value', () => {
    const err = validateThemeStyle('long-paragraph');
    expect(err).toMatch(/long-paragraph.*not valid/);
  });
});

// --- validateLanguage ---

describe('validateLanguage', () => {
  test('returns null for valid languages', () => {
    expect(validateLanguage('portuguese')).toBeNull();
    expect(validateLanguage('english')).toBeNull();
  });
  test('returns error string for invalid language', () => {
    const err = validateLanguage('french');
    expect(err).not.toBeNull();
    expect(err).toContain('language');
  });
});

// --- validatePipelineConfig ---

describe('validatePipelineConfig', () => {
  test('accepts valid config', () => {
    const errors = validatePipelineConfig({ classifyEvery: 5, organizeAfterClassifies: 2 });
    expect(errors).toHaveLength(0);
  });

  test('rejects non-integer classifyEvery', () => {
    const errors = validatePipelineConfig({ classifyEvery: 1.5 });
    expect(errors[0]).toMatch(/classifyEvery.*positive integer/);
  });

  test('rejects zero', () => {
    const errors = validatePipelineConfig({ organizeAfterClassifies: 0 });
    expect(errors[0]).toMatch(/organizeAfterClassifies.*positive integer/);
  });

  test('rejects negative', () => {
    const errors = validatePipelineConfig({ consolidateAfterOrganizes: -1 });
    expect(errors[0]).toMatch(/consolidateAfterOrganizes.*positive integer/);
  });

  test('non-object → error', () => {
    const errors = validatePipelineConfig('bad');
    expect(errors[0]).toMatch(/pipelineConfig.*must be an object/);
  });
});

// --- validateVaultLinks ---

describe('validateVaultLinks', () => {
  test('accepts true', () => {
    expect(validateVaultLinks(true)).toBeNull();
  });
  test('accepts false', () => {
    expect(validateVaultLinks(false)).toBeNull();
  });
  test('rejects string', () => {
    const err = validateVaultLinks('true');
    expect(err).toMatch(/vaultLinks.*boolean/);
  });
  test('rejects number', () => {
    const err = validateVaultLinks(1);
    expect(err).toMatch(/vaultLinks.*boolean/);
  });
});
