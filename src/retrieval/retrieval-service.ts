import { normalizeVector, searchVectors } from './vector-search';
import type {
  EmbeddingClient,
  RetrievalResponse,
  VectorIndexSnapshot,
  VectorSearchHit,
} from '../types';

export class RetrievalService {
  constructor(private readonly embeddings: EmbeddingClient) {}

  async search(
    query: string,
    index: VectorIndexSnapshot,
    topK: number,
    backendSearch?: (queryVector: number[], topK: number) => Promise<VectorSearchHit[] | null>,
  ): Promise<RetrievalResponse> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) throw new Error('Enter a search query.');
    if (index.chunks.length === 0) throw new Error('The index is empty. Rebuild it in settings.');

    const currentFingerprint = await this.embeddings.getFingerprint();
    if (currentFingerprint !== index.embeddingFingerprint) {
      throw new Error('The local Qwen embedding model changed. Rebuild the index before searching.');
    }

    const [queryVector] = await this.embeddings.embed([normalizedQuery]);
    if (!queryVector) throw new Error('Failed to create an embedding for the search query.');
    const normalizedVector = normalizeVector(queryVector);
    if (!normalizedVector) throw new Error('Не удалось нормализовать поисковый embedding-вектор.');
    const backendHits = await backendSearch?.(Array.from(normalizedVector), topK);
    const results = backendHits
      ? backendHits
          .filter((hit) => hit.score >= 0.15 && index.chunks[hit.index])
          .map((hit, position) => ({
            chunk: index.chunks[hit.index]!,
            score: hit.score,
            sourceId: `S${position + 1}`,
          }))
      : searchVectors(index.chunks, Array.from(normalizedVector), topK);
    return {
      query: normalizedQuery,
      strategy: index.chunkingStrategy,
      results,
    };
  }
}
