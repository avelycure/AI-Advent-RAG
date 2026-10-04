import { describe, expect, it } from 'vitest';
import { GroundingValidationError, parseGroundedResponse } from '../src/rag/grounded-response';
import type { SearchResult } from '../src/types';
import { indexedChunk } from './test-fixtures';

const source: SearchResult = {
  sourceId: 'S1',
  score: 0.82,
  chunk: indexedChunk('chunk-1', [1, 0], {
    text: 'Первая строка. Нужный факт подтверждён заметкой. Последняя строка.',
    metadata: {
      source: 'Книги/Заметка.md',
      title: 'Заметка',
      section: 'Итог',
      chunk_id: 'chunk-1',
      line_start: 10,
      line_end: 12,
      file_mtime: 1,
    },
  }),
};

describe('grounded model response', () => {
  it('accepts only trusted metadata and a verbatim quote', () => {
    const response = parseGroundedResponse(JSON.stringify({
      status: 'answered',
      answer: 'Нужный факт подтверждён [S1].',
      sources: [{
        source_id: 'S1',
        source: 'Книги/Заметка.md',
        section: 'Итог',
        chunk_id: 'chunk-1',
        quote: 'Нужный факт подтверждён заметкой.',
      }],
    }), [source]);
    expect(response).toEqual({
      status: 'grounded',
      answer: 'Нужный факт подтверждён [S1].',
      citations: [{
        sourceId: 'S1',
        source: 'Книги/Заметка.md',
        section: 'Итог',
        chunkId: 'chunk-1',
        quote: 'Нужный факт подтверждён заметкой.',
      }],
    });
  });

  it('rejects fabricated metadata, quotes, and source IDs', () => {
    expect(() => parseGroundedResponse(JSON.stringify({
      status: 'answered',
      answer: 'Выдумка [S2].',
      sources: [{
        source_id: 'S2',
        source: 'Подмена.md',
        section: null,
        chunk_id: 'fake',
        quote: 'Этой цитаты нет.',
      }],
    }), [source])).toThrow(GroundingValidationError);
  });

  it('requires citations for answered responses', () => {
    expect(() => parseGroundedResponse(JSON.stringify({
      status: 'answered',
      answer: 'Ответ без подтверждения.',
      sources: [],
    }), [source])).toThrow(/непустой список sources/u);
  });

  it('accepts a structured refusal only with “не знаю” and a clarification request', () => {
    expect(parseGroundedResponse(JSON.stringify({
      status: 'not_enough_context',
      answer: 'Не знаю. Пожалуйста, уточните вопрос.',
      sources: [],
    }), [source])).toEqual({
      status: 'not-enough-context',
      answer: 'Не знаю. Пожалуйста, уточните вопрос.',
      citations: [],
    });
    expect(() => parseGroundedResponse(JSON.stringify({
      status: 'not_enough_context',
      answer: 'Не знаю. Пожалуйста, уточните вопрос.',
    }), [source])).toThrow(/поле sources должно быть массивом/u);
  });
});
