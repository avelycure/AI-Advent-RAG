import { describe, expect, it } from 'vitest';
import { RetrievalService } from '../src/retrieval/retrieval-service';
import type { EmbeddingClient } from '../src/types';
import { indexedChunk, indexSnapshot } from './test-fixtures';

const unfiltered = (topK: number) => ({
  candidateTopK: topK,
  finalTopK: topK,
  minimumScore: -1,
});

class Embeddings implements EmbeddingClient {
  calls: string[][] = [];

  async embed(input: string[]): Promise<number[][]> {
    this.calls.push(input);
    return [[1, 0]];
  }

  async testConnection(): Promise<void> {}

  async getFingerprint(): Promise<string> {
    return 'digest';
  }
}

describe('retrieval-only service', () => {
  it('embeds the query locally once and returns ranked chunks without an LLM config', async () => {
    const embeddings = new Embeddings();
    const service = new RetrievalService(embeddings);
    const response = await service.search(
      'Question',
      indexSnapshot([
        indexedChunk('best', [1, 0]),
        indexedChunk('second', [0.8, 0.2]),
      ]),
      unfiltered(2),
    );

    expect(embeddings.calls).toEqual([['Question']]);
    expect(response.results.map((result) => result.chunk.metadata.chunk_id)).toEqual([
      'best',
      'second',
    ]);
    expect(response.strategy).toBe('structure-aware');
  });

  it('returns an empty list when no fragment meets the similarity threshold', async () => {
    const service = new RetrievalService(new Embeddings());
    const response = await service.search(
      'Question',
      indexSnapshot([indexedChunk('opposite', [-1, 0])]),
      { candidateTopK: 5, finalTopK: 5, minimumScore: 0.15 },
    );
    expect(response.results).toEqual([]);
  });

  it('uses backend vector search when the selected storage provides it', async () => {
    const service = new RetrievalService(new Embeddings());
    const backendQueries: number[][] = [];
    const response = await service.search(
      'Question',
      indexSnapshot([
        indexedChunk('first', [1, 0]),
        indexedChunk('from-backend', [0, 1]),
      ]),
      unfiltered(1),
      async (query, topK) => {
        backendQueries.push(query);
        expect(topK).toBe(1);
        return [{ index: 1, score: 0.75 }];
      },
    );

    expect(backendQueries).toEqual([[1, 0]]);
    expect(response.results[0]?.chunk.metadata.chunk_id).toBe('from-backend');
    expect(response.results[0]?.score).toBe(0.75);
  });

  it('rejects empty queries before embedding', async () => {
    const embeddings = new Embeddings();
    const service = new RetrievalService(embeddings);
    await expect(service.search('  ', indexSnapshot([indexedChunk('one')]), unfiltered(5))).rejects.toThrow(
      /search query/i,
    );
    expect(embeddings.calls).toEqual([]);
  });

  it('requires a rebuild when the local embedding model fingerprint changes', async () => {
    const embeddings = new Embeddings();
    embeddings.getFingerprint = async () => 'new-digest';
    const service = new RetrievalService(embeddings);
    await expect(
      service.search(
        'Question',
        indexSnapshot([indexedChunk('one')], { embeddingFingerprint: 'old-digest' }),
        unfiltered(5),
      ),
    ).rejects.toThrow(/embedding model changed/i);
    expect(embeddings.calls).toEqual([]);
  });

  it('retrieves a wider candidate set, applies the configured threshold, and caps final results', async () => {
    const service = new RetrievalService(new Embeddings());
    const response = await service.search(
      'Question',
      indexSnapshot([
        indexedChunk('best', [1, 0]),
        indexedChunk('kept', [0.8, 0.2]),
        indexedChunk('filtered', [0.2, 0.8]),
      ]),
      { candidateTopK: 3, finalTopK: 1, minimumScore: 0.5 },
    );

    expect(response.candidateCount).toBe(3);
    expect(response.results.map((result) => result.chunk.metadata.chunk_id)).toEqual(['best']);
    expect(response.results[0]?.sourceId).toBe('S1');
  });

  it('uses a strong chunk as a source anchor and reranks useful sibling chunks', async () => {
    const service = new RetrievalService(new Embeddings());
    const heading = indexedChunk('heading', [1, 0], { text: '# Target note' });
    heading.metadata.source = 'target.md';
    const body = indexedChunk('body', [0.4, 0.6], {
      text: '## Useful section\n' + 'Useful details. '.repeat(20),
    });
    body.metadata.source = 'target.md';
    body.metadata.section = 'Target note › Useful section';
    const unrelated = indexedChunk('unrelated', [0.7, 0.3]);
    unrelated.metadata.source = 'other.md';

    const response = await service.search(
      'Question',
      indexSnapshot([heading, unrelated, body]),
      {
        candidateTopK: 3,
        finalTopK: 2,
        minimumScore: 0.56,
        expandRelevantSources: true,
      },
    );

    expect(response.results.map((result) => result.chunk.metadata.source)).toEqual([
      'target.md',
      'target.md',
    ]);
    expect(response.results.map((result) => result.chunk.metadata.chunk_id)).toContain('body');
  });

  it('rejects medium semantic matches without metadata overlap but keeps a named source', async () => {
    const embeddings = new Embeddings();
    const service = new RetrievalService(embeddings);
    const unrelated = indexedChunk('unrelated', [0.55, 0.84]);
    unrelated.metadata.source = 'Рецепты/Карри.md';
    unrelated.metadata.title = 'Карри';
    const named = indexedChunk('named', [0.5, 0.86]);
    named.metadata.source = 'Фильмы/Паразиты.md';
    named.metadata.title = 'Паразиты';

    const rejected = await service.search(
      'кофемолка настройка помола',
      indexSnapshot([unrelated]),
      {
        candidateTopK: 1,
        finalTopK: 1,
        minimumScore: 0.35,
        expandRelevantSources: true,
      },
    );
    const accepted = await service.search(
      'Паразиты дом и дождь',
      indexSnapshot([named]),
      {
        candidateTopK: 1,
        finalTopK: 1,
        minimumScore: 0.35,
        expandRelevantSources: true,
      },
    );

    expect(rejected.results).toEqual([]);
    expect(accepted.results[0]?.chunk.metadata.chunk_id).toBe('named');
  });

  it('recognizes an inflected Russian title as a metadata anchor', async () => {
    const service = new RetrievalService(new Embeddings());
    const unrelated = indexedChunk('salmon', [0.9, 0.1]);
    unrelated.metadata.source = 'Рецепты/Лосось.md';
    unrelated.metadata.title = 'Лосось';
    const named = indexedChunk('carbonara', [0.6, 0.4]);
    named.metadata.source = 'Рецепты/Паста карбонара.md';
    named.metadata.title = 'Паста карбонара';

    const response = await service.search(
      'Почему в карбонаре соус пошёл хлопьями?',
      indexSnapshot([unrelated, named]),
      {
        candidateTopK: 2,
        finalTopK: 1,
        minimumScore: 0.35,
        expandRelevantSources: true,
      },
    );

    expect(response.results[0]?.chunk.metadata.chunk_id).toBe('carbonara');
  });
});
