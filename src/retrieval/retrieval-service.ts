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
const GENERIC_METADATA_QUERY_TOKENS = new Set([
  'документ',
  'документа',
  'документе',
  'документы',
  'документов',
  'заметка',
  'заметке',
  'заметки',
  'заметок',
  'заметку',
  'записи',
  'записей',
  'запись',
  'источник',
  'источника',
  'источники',
  'раздел',
  'раздела',
  'разделе',
  'разделы',
  'текст',
  'текста',
  'тексте',
  'тексты',
  'файл',
  'файла',
  'файле',
  'файлы',
  'document',
  'documents',
  'file',
  'files',
  'note',
  'notes',
  'section',
  'sections',
  'source',
  'sources',
  'text',
]);

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
    const metadataMatchCounts = aboveMinimum.map((candidate) => ({
      candidate,
      count: metadataTokenOverlapCount(normalizedQuery, candidate),
    }));
    const strongestMetadataMatch = Math.max(
      0,
      ...metadataMatchCounts.map((match) => match.count),
    );
    const metadataMatches = metadataMatchCounts
      .filter((match) => match.count === strongestMetadataMatch && match.count > 0)
      .map((match) => match.candidate);
    const thresholdMatches = !options.expandRelevantSources
      ? aboveMinimum
      : metadataMatches.length > 0
        ? metadataMatches
        : aboveMinimum.filter(
            (candidate) => candidate.score >= Math.max(STRONG_SEMANTIC_SCORE, minimumScore),
          );
    const eligible = options.expandRelevantSources
      ? expandAnchoredSources(index.chunks, Array.from(normalizedVector), thresholdMatches)
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
  chunks: VectorIndexSnapshot['chunks'],
  queryVector: readonly number[],
  thresholdMatches: RetrievalResponse['results'],
): RetrievalResponse['results'] {
  const bestScore = thresholdMatches[0]?.score;
  if (bestScore === undefined) return [];
  const anchoredSources = new Set(
    thresholdMatches
      .filter((candidate) => candidate.score >= bestScore - SOURCE_ANCHOR_MARGIN)
      .map((candidate) => candidate.chunk.metadata.source),
  );
  const sourceChunks = chunks.filter((chunk) => anchoredSources.has(chunk.metadata.source));
  return searchVectors(sourceChunks, queryVector, sourceChunks.length, -1);
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

function metadataTokenOverlapCount(
  query: string,
  candidate: RetrievalResponse['results'][number],
): number {
  const queryTokens = [...tokens(query)].filter(isDistinctiveMetadataQueryToken);
  if (queryTokens.length === 0) return 0;
  const metadataTokens = tokens([
    candidate.chunk.metadata.source,
    candidate.chunk.metadata.title,
  ].join(' '));
  return queryTokens.filter((queryToken) =>
    [...metadataTokens].some((metadataToken) => tokensLexicallyMatch(queryToken, metadataToken)),
  ).length;
}

function isDistinctiveMetadataQueryToken(token: string): boolean {
  return !GENERIC_METADATA_QUERY_TOKENS.has(token);
}

function tokensLexicallyMatch(left: string, right: string): boolean {
  if (left === right) return true;
  const shorterLength = Math.min(left.length, right.length);
  if (shorterLength < 5 || Math.abs(left.length - right.length) > 3) return false;
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
