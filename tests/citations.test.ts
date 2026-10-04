import { describe, expect, it } from 'vitest';
import { citationParts, sourceLinkText } from '../src/retrieval/citations';
import type { SearchResult } from '../src/types';
import { indexedChunk } from './test-fixtures';

const source: SearchResult = {
  sourceId: 'S1',
  score: 0.9,
  chunk: indexedChunk('1', [1], {
    text: 'text',
    contentHash: 'hash',
    metadata: {
      source: 'Проект/Архитектура.md',
      title: 'Архитектура',
      section: 'Проект › Индекс',
      chunk_id: '1',
      line_start: 4,
      line_end: 8,
      file_mtime: 1,
    },
  }),
};

describe('citations', () => {
  it('links only known source identifiers', () => {
    const parts = citationParts('Answer [S1], unknown [S99].', [source]);
    expect(parts.find((part) => part.text === '[S1]')?.source).toBe(source);
    expect(parts.find((part) => part.text === '[S99]')?.source).toBeUndefined();
  });

  it('builds links from trusted metadata instead of model text', () => {
    expect(sourceLinkText(source)).toBe('Проект/Архитектура.md#Индекс');
  });
});
