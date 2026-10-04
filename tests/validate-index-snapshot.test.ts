import { describe, expect, it } from 'vitest';
import { validateIndexSnapshot } from '../src/rag/validate-index-snapshot';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { indexSnapshot } from './test-fixtures';

describe('RAG index freshness', () => {
  it('rejects a stale snapshot before any remote RAG request can use it', () => {
    expect(() => validateIndexSnapshot(
      indexSnapshot([]),
      { ...DEFAULT_SETTINGS, indexNeedsRebuild: true },
      'all:',
    )).toThrow(/перестройте индекс/i);
  });

  it('accepts a matching fresh snapshot', () => {
    const snapshot = indexSnapshot([], { chunkingStrategy: 'fixed-size' });
    expect(validateIndexSnapshot(
      snapshot,
      { ...DEFAULT_SETTINGS, indexNeedsRebuild: false },
      'all:',
    )).toBe(snapshot);
  });
});
