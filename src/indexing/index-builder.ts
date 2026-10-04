import { chunkDocument, countCharacters, DEFAULT_OVERLAP_CHARS } from './markdown-chunker';
import { normalizeVector } from '../retrieval/vector-search';
import {
  CHUNKER_VERSION,
  EMBEDDING_MODEL,
  INDEX_SCHEMA_VERSION,
  type ChunkingComparison,
  type ChunkingMetrics,
  type ChunkingStrategy,
  type EmbeddingClient,
  type IndexProgress,
  type SourceDocument,
  type StructureChunkingUnit,
  type TextChunk,
  type VectorIndexSnapshot,
} from '../types';

export interface BuildIndexOptions {
  scopeSignature: string;
  chunkingStrategy: ChunkingStrategy;
  structureChunkingUnit: StructureChunkingUnit;
  fixedChunkSize: number;
  batchSize?: number;
  totalDocuments?: number;
  onProgress?: (progress: IndexProgress) => void;
}

export async function buildIndex(
  documents: Iterable<SourceDocument> | AsyncIterable<SourceDocument>,
  embeddingClient: EmbeddingClient,
  options: BuildIndexOptions,
): Promise<VectorIndexSnapshot> {
  const batchSize = Math.max(
    1,
    options.batchSize ?? (options.chunkingStrategy === 'structure-aware' ? 1 : 16),
  );
  const totalDocuments = options.totalDocuments ?? (Array.isArray(documents) ? documents.length : 0);
  const pendingChunks: TextChunk[] = [];
  const indexedChunks: VectorIndexSnapshot['chunks'] = [];
  let vectorDimension = 0;
  let documentIndex = 0;
  let embeddedCount = 0;
  const embeddingFingerprint = await embeddingClient.getFingerprint();
  const comparison = new ChunkingComparisonAccumulator(options.structureChunkingUnit);

  const embedPending = async (count: number): Promise<void> => {
    const batch = pendingChunks.splice(0, count);
    let batchVectors: number[][];
    try {
      batchVectors = await embeddingClient.embed(
        batch.map((chunk) => embeddingText(chunk, options)),
      );
    } catch (error) {
      if (options.chunkingStrategy === 'structure-aware' && batch[0]) {
        throw structuralEmbeddingError(batch[0], error);
      }
      throw error;
    }
    if (batchVectors.length !== batch.length) {
      throw new Error('Ollama вернула неожиданное количество embedding-векторов.');
    }
    for (let index = 0; index < batch.length; index += 1) {
      const chunk = batch[index];
      const vector = normalizeVector(batchVectors[index] ?? []);
      if (!chunk || !vector) {
        throw new Error(
          `Ollama вернула нулевой или некорректный вектор для ${chunk?.metadata.source ?? 'заметки'}.`,
        );
      }
      if (vectorDimension === 0) vectorDimension = vector.length;
      if (vector.length !== vectorDimension) {
        throw new Error('Embedding-векторы имеют разную размерность.');
      }
      indexedChunks.push({ ...chunk, vector });
    }
    embeddedCount += batch.length;
    options.onProgress?.({
      phase: 'embedding',
      completed: embeddedCount,
      total: Math.max(embeddedCount, indexedChunks.length + pendingChunks.length),
      currentPath: batch.at(-1)?.metadata.source,
    });
  };

  for await (const document of documents) {
    documentIndex += 1;
    options.onProgress?.({
      phase: 'reading',
      completed: documentIndex,
      total: totalDocuments || documentIndex,
      currentPath: document.path,
    });
    const fixedSizeChunks = chunkDocument(
      document,
      'fixed-size',
      fixedChunkOptions(options.fixedChunkSize),
    );
    const structureAwareChunks = chunkDocument(document, 'structure-aware', {
      structureUnit: options.structureChunkingUnit,
    });
    comparison.addDocument(countCharacters(document.content), fixedSizeChunks, structureAwareChunks);
    pendingChunks.push(
      ...(options.chunkingStrategy === 'fixed-size' ? fixedSizeChunks : structureAwareChunks),
    );
    while (pendingChunks.length >= batchSize) await embedPending(batchSize);
  }
  if (pendingChunks.length > 0) await embedPending(pendingChunks.length);
  return {
    schemaVersion: INDEX_SCHEMA_VERSION,
    chunkerVersion: CHUNKER_VERSION,
    embeddingModel: EMBEDDING_MODEL,
    embeddingFingerprint,
    vectorDimension,
    builtAt: Date.now(),
    scopeSignature: options.scopeSignature,
    chunkingStrategy: options.chunkingStrategy,
    structureChunkingUnit: options.structureChunkingUnit,
    fixedChunkSize: options.fixedChunkSize,
    chunkingComparison: comparison.result(),
    chunks: indexedChunks,
  };
}

function embeddingText(chunk: TextChunk, options: BuildIndexOptions): string {
  if (
    options.chunkingStrategy === 'structure-aware' &&
    options.structureChunkingUnit === 'paragraph' &&
    chunk.metadata.section
  ) {
    return `${chunk.metadata.section}\n${chunk.text}`;
  }
  return chunk.text;
}

function structuralEmbeddingError(chunk: TextChunk, error: unknown): Error {
  const source = chunk.metadata.section
    ? `«${chunk.metadata.source}», раздел «${chunk.metadata.section}»`
    : `«${chunk.metadata.source}»`;
  const detail = error instanceof Error ? error.message : String(error);
  if (/HTTP 400|context|token/i.test(detail)) {
    return new Error(
      `Чанк ${source} слишком велик для контекста ${EMBEDDING_MODEL}. Выберите меньшую структурную единицу или сократите заметку.`,
    );
  }
  return new Error(`Не удалось создать эмбеддинг для чанка ${source}: ${detail}`);
}

export async function compareChunking(
  documents: Iterable<SourceDocument> | AsyncIterable<SourceDocument>,
  fixedChunkSize: number,
  structureChunkingUnit: StructureChunkingUnit,
): Promise<ChunkingComparison> {
  const comparison = new ChunkingComparisonAccumulator(structureChunkingUnit);
  for await (const document of documents) {
    comparison.addDocument(
      countCharacters(document.content),
      chunkDocument(document, 'fixed-size', fixedChunkOptions(fixedChunkSize)),
      chunkDocument(document, 'structure-aware', { structureUnit: structureChunkingUnit }),
    );
  }
  return comparison.result();
}

function fixedChunkOptions(fixedChunkSize: number): { maxChars: number; overlapChars: number } {
  return {
    maxChars: fixedChunkSize,
    overlapChars: Math.min(DEFAULT_OVERLAP_CHARS, Math.floor(fixedChunkSize / 8)),
  };
}

class ChunkingComparisonAccumulator {
  private documentCount = 0;
  private sourceCharacters = 0;
  private readonly fixedLengths: number[] = [];
  private readonly structureLengths: number[] = [];
  private structureChunksWithSections = 0;

  constructor(private readonly structureChunkingUnit: StructureChunkingUnit) {}

  addDocument(
    sourceCharacters: number,
    fixedSizeChunks: readonly TextChunk[],
    structureAwareChunks: readonly TextChunk[],
  ): void {
    this.documentCount += 1;
    this.sourceCharacters += sourceCharacters;
    this.fixedLengths.push(...fixedSizeChunks.map((chunk) => countCharacters(chunk.text)));
    this.structureLengths.push(
      ...structureAwareChunks.map((chunk) => countCharacters(chunk.text)),
    );
    this.structureChunksWithSections += structureAwareChunks.filter(
      (chunk) => chunk.metadata.section,
    ).length;
  }

  result(): ChunkingComparison {
    return {
      documentCount: this.documentCount,
      sourceCharacters: this.sourceCharacters,
      estimatedPages: roundOneDecimal(this.sourceCharacters / 1800),
      structureChunkingUnit: this.structureChunkingUnit,
      fixedSize: metrics('fixed-size', this.fixedLengths, 0),
      structureAware: metrics(
        'structure-aware',
        this.structureLengths,
        this.structureChunksWithSections,
      ),
    };
  }
}

function metrics(
  strategy: ChunkingStrategy,
  lengths: readonly number[],
  chunksWithSections: number,
): ChunkingMetrics {
  if (lengths.length === 0) {
    return {
      strategy,
      chunkCount: 0,
      averageCharacters: 0,
      p95Characters: 0,
      sectionMetadataPercent: 0,
    };
  }
  const sorted = [...lengths].sort((left, right) => left - right);
  const p95Index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return {
    strategy,
    chunkCount: lengths.length,
    averageCharacters: Math.round(
      lengths.reduce((total, length) => total + length, 0) / lengths.length,
    ),
    p95Characters: sorted[p95Index] ?? 0,
    sectionMetadataPercent: Math.round((chunksWithSections / lengths.length) * 100),
  };
}

function roundOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}
