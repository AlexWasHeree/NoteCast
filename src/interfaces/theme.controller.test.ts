import { describe, expect, test } from 'bun:test';
import type { Theme } from '../domain/theme/theme.entity';
import { toPublicTheme } from './theme.controller';

function makeTheme(overrides: Partial<Theme> = {}): Theme {
  return {
    id: 't1',
    name: 'Test Theme',
    parentIds: [],
    noteIds: [],
    createdAt: new Date('2026-01-01'),
    ...overrides,
  };
}

describe('toPublicTheme', () => {
  test('strips descriptionVector', () => {
    const theme = makeTheme({ descriptionVector: [0.1, 0.2, 0.3] });
    const pub = toPublicTheme(theme);
    expect((pub as any).descriptionVector).toBeUndefined();
  });

  test('preserves all other fields', () => {
    const theme = makeTheme({ description: 'About science' });
    const pub = toPublicTheme(theme);
    expect(pub.id).toBe('t1');
    expect(pub.name).toBe('Test Theme');
    expect(pub.description).toBe('About science');
    expect(pub.parentIds).toEqual([]);
    expect(pub.noteIds).toEqual([]);
  });
});
