import { describe, expect, it } from 'bun:test';
import { getPrompts, type Language } from '../llm/prompts';

const LANGUAGES: Language[] = ['portuguese', 'english'];

describe('getPrompts', () => {
  it('returns non-empty summary for each language', () => {
    for (const lang of LANGUAGES) {
      expect(getPrompts(lang).summary.length).toBeGreaterThan(10);
    }
  });

  it('returns non-empty classifyBase for each language', () => {
    for (const lang of LANGUAGES) {
      expect(getPrompts(lang).classifyBase.length).toBeGreaterThan(10);
    }
  });

  it('returns styleInstructions with all required keys', () => {
    const keys = ['single-word', 'short-phrase', 'descriptive'];
    for (const lang of LANGUAGES) {
      const p = getPrompts(lang);
      for (const k of keys) {
        expect(p.styleInstructions[k]).toBeTruthy();
      }
    }
  });

  it('returns non-empty organizeBase for each language', () => {
    for (const lang of LANGUAGES) {
      expect(getPrompts(lang).organizeBase.length).toBeGreaterThan(10);
    }
  });

  it('returns non-empty consolidateBase for each language', () => {
    for (const lang of LANGUAGES) {
      expect(getPrompts(lang).consolidateBase.length).toBeGreaterThan(10);
    }
  });

  it('splitDepthCaution returns empty string for depth < 2', () => {
    for (const lang of LANGUAGES) {
      expect(getPrompts(lang).splitDepthCaution(0)).toBe('');
      expect(getPrompts(lang).splitDepthCaution(1)).toBe('');
    }
  });

  it('splitDepthCaution returns non-empty string for depth >= 2', () => {
    for (const lang of LANGUAGES) {
      expect(getPrompts(lang).splitDepthCaution(2).length).toBeGreaterThan(0);
    }
  });

  it('summaryPromptLabels has titleLabel and contentLabel for each language', () => {
    for (const lang of LANGUAGES) {
      const p = getPrompts(lang);
      expect(p.summaryPromptLabels.titleLabel.length).toBeGreaterThan(0);
      expect(p.summaryPromptLabels.contentLabel.length).toBeGreaterThan(0);
    }
  });

  it('noteFormatterLabels has all 4 keys for each language', () => {
    for (const lang of LANGUAGES) {
      const p = getPrompts(lang);
      expect(p.noteFormatterLabels.summaryLabel.length).toBeGreaterThan(0);
      expect(p.noteFormatterLabels.noSummaryLabel.length).toBeGreaterThan(0);
      expect(p.noteFormatterLabels.topicsLabel.length).toBeGreaterThan(0);
      expect(p.noteFormatterLabels.noTopicsLabel.length).toBeGreaterThan(0);
    }
  });

  it('splitFallbackInstruction is non-empty for each language', () => {
    for (const lang of LANGUAGES) {
      expect(getPrompts(lang).splitFallbackInstruction.length).toBeGreaterThan(10);
    }
  });

  it('splitJsonInstruction is non-empty for each language', () => {
    for (const lang of LANGUAGES) {
      expect(getPrompts(lang).splitJsonInstruction.length).toBeGreaterThan(10);
    }
  });
});
