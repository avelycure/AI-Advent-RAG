import { normalizeVector, searchVectors } from './vector-search';
import type {
  EmbeddingClient,
  RetrievalOptions,
  RetrievalResponse,
  VectorIndexSnapshot,
  VectorSearchHit,
} from '../types';

const SOURCE_ANCHOR_MARGIN = 0.05;
const STRONG_SEMANTIC_SCORE = 0.56;

export class RetrievalService {
  constructor(private readonly embeddings: EmbeddingClient) {}

  async search(
    query: string,
    index: VectorIndexSnapshot,
    options: RetrievalOptions,
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
    const candidateTopK = Math.max(1, Math.round(options.candidateTopK));
    const finalTopK = Math.max(1, Math.min(candidateTopK, Math.round(options.finalTopK)));
    const minimumScore = Math.max(-1, Math.min(1, options.minimumScore));
    const backendHits = await backendSearch?.(Array.from(normalizedVector), candidateTopK);
    const candidates = backendHits
      ? backendHits
          .filter((hit) => Number.isFinite(hit.score) && index.chunks[hit.index])
          .map((hit) => ({
            chunk: index.chunks[hit.index]!,
            score: hit.score,
            sourceId: '',
          }))
          .sort((left, right) => right.score - left.score)
          .slice(0, candidateTopK)
      : searchVectors(index.chunks, Array.from(normalizedVector), candidateTopK, -1);
    const aboveMinimum = candidates.filter((candidate) => candidate.score >= minimumScore);
    const metadataMatches = aboveMinimum.filter((candidate) =>
      hasMetadataTokenOverlap(normalizedQuery, candidate),
    );
    const thresholdMatches = !options.expandRelevantSources
      ? aboveMinimum
      : metadataMatches.length > 0
        ? metadataMatches
        : aboveMinimum.filter(
            (candidate) => candidate.score >= Math.max(STRONG_SEMANTIC_SCORE, minimumScore),
          );
    const eligible = options.expandRelevantSources
      ? expandAnchoredSources(candidates, thresholdMatches)
      : thresholdMatches;
    const results = eligible
      .sort((left, right) =>
        options.expandRelevantSources
          ? heuristicScore(right) - heuristicScore(left)
          : right.score - left.score,
      )
      .slice(0, finalTopK)
      .map((candidate, position) => ({ ...candidate, sourceId: `S${position + 1}` }));
    return {
      query: normalizedQuery,
      strategy: index.chunkingStrategy,
      results,
      candidateCount: candidates.length,
    };
  }
}

function expandAnchoredSources(
  candidates: RetrievalResponse['results'],
  thresholdMatches: RetrievalResponse['results'],
): RetrievalResponse['results'] {
  const bestScore = thresholdMatches[0]?.score;
  if (bestScore === undefined) return [];
  const anchoredSources = new Set(
    thresholdMatches
      .filter((candidate) => candidate.score >= bestScore - SOURCE_ANCHOR_MARGIN)
      .map((candidate) => candidate.chunk.metadata.source),
  );
  return candidates.filter((candidate) => anchoredSources.has(candidate.chunk.metadata.source));
}

function heuristicScore(candidate: RetrievalResponse['results'][number]): number {
  const text = candidate.chunk.text.trim();
  const lines = text.split(/\r?\n/u).filter((line) => line.trim());
  const isHeadingOnly = lines.length === 1 && /^#{1,6}\s/u.test(lines[0] ?? '');
  const isFrontmatter = text.startsWith('---');
  const nestedSection = candidate.chunk.metadata.section?.includes(' › ') ?? false;
  return candidate.score +
    (nestedSection ? 0.04 : 0) +
    (text.length >= 160 ? 0.03 : 0) -
    (isHeadingOnly ? 0.12 : 0) -
    (isFrontmatter ? 0.08 : 0);
}

function hasMetadataTokenOverlap(
  query: string,
  candidate: RetrievalResponse['results'][number],
): boolean {
  const queryTokens = tokens(query);
  if (queryTokens.size === 0) return false;
  const metadataTokens = tokens([
    candidate.chunk.metadata.source,
    candidate.chunk.metadata.title,
    candidate.chunk.metadata.section ?? '',
  ].join(' '));
  return [...queryTokens].some((queryToken) =>
    [...metadataTokens].some((metadataToken) => tokensLexicallyMatch(queryToken, metadataToken)),
  );
}

function tokensLexicallyMatch(left: string, right: string): boolean {
  if (left === right) return true;
  const shorterLength = Math.min(left.length, right.length);
  if (shorterLength < 6 || Math.abs(left.length - right.length) > 3) return false;
  const requiredPrefixLength = Math.max(5, shorterLength - 2);
  return left.slice(0, requiredPrefixLength) === right.slice(0, requiredPrefixLength);
}

function tokens(value: string): Set<string> {
  return new Set(
    value
      .toLocaleLowerCase('ru-RU')
      .match(/[\p{L}\p{N}]+/gu)
      ?.filter((token) => token.length >= 4) ?? [],
  );
}
