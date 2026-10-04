import { describe, expect, it } from 'vitest';
import { searchVectors } from '../src/retrieval/vector-search';
import type { IndexedChunk } from '../src/types';
import { indexedChunk } from './test-fixtures';

function chunk(id: string, vector: number[]): IndexedChunk {
  return indexedChunk(id, vector);
}

describe('vector search', () => {
  it('ranks by cosine similarity and assigns deterministic source ids', () => {
    const results = searchVectors(
      [
        chunk('same', [1, 0]),
        chunk('diagonal', [Math.SQRT1_2, Math.SQRT1_2]),
        chunk('opposite', [-1, 0]),
      ],
      [1, 0],
      2,
      -1,
    );
    expect(results.map((result) => [result.chunk.metadata.chunk_id, result.sourceId])).toEqual([
      ['same', 'S1'],
      ['diagonal', 'S2'],
    ]);
    expect(results[0]?.score).toBeCloseTo(1);
  });

  it('ignores invalid and zero vectors', () => {
    expect(searchVectors([chunk('zero', [0, 0]), chunk('nan', [Number.NaN, 1])], [1, 0], 5)).toEqual([]);
  });

  it('rejects mismatched dimensions', () => {
    expect(() => searchVectors([chunk('bad', [1, 2, 3])], [1, 2], 1)).toThrow(/dimension/i);
  });
});
