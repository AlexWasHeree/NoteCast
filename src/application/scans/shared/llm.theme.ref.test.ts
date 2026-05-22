import { describe, expect, test } from 'bun:test';
import type { Theme } from '../../../domain/theme/theme.entity';
import { resolveThemeIdFromLlm } from './llm.theme.ref';

function t(id: string, name: string): Theme {
  return { id, name, noteIds: [], createdAt: new Date(), parentIds: [] };
}

describe('resolveThemeIdFromLlm', () => {
  test('returns id when raw is existing theme id', () => {
    const map = new Map([['u1', t('u1', 'Alpha')]]);
    expect(resolveThemeIdFromLlm('u1', map)).toBe('u1');
  });

  test('resolves unique exact name to id', () => {
    const map = new Map([['u1', t('u1', 'Artes')]]);
    expect(resolveThemeIdFromLlm('Artes', map)).toBe('u1');
  });

  test('returns null for unknown string', () => {
    const map = new Map([['u1', t('u1', 'Alpha')]]);
    expect(resolveThemeIdFromLlm('Fantasma', map)).toBeNull();
  });

  test('returns null when name matches multiple themes', () => {
    const map = new Map<string, Theme>([
      ['a', t('a', 'Dup')],
      ['b', t('b', 'Dup')],
    ]);
    expect(resolveThemeIdFromLlm('Dup', map)).toBeNull();
  });

  test('trims whitespace', () => {
    const map = new Map([['u1', t('u1', 'X')]]);
    expect(resolveThemeIdFromLlm('  u1  ', map)).toBe('u1');
    expect(resolveThemeIdFromLlm('  X  ', map)).toBe('u1');
  });
});
