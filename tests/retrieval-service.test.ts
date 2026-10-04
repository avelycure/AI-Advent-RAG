import { describe, expect, it } from 'vitest';
import { RetrievalService } from '../src/retrieval/retrieval-service';
import type { EmbeddingClient } from '../src/types';
import { indexedChunk, indexSnapshot } from './test-fixtures';

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
      2,
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
      5,
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
      1,
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
    await expect(service.search('  ', indexSnapshot([indexedChunk('one')]), 5)).rejects.toThrow(
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
        5,
      ),
    ).rejects.toThrow(/embedding model changed/i);
    expect(embeddings.calls).toEqual([]);
  });
});
