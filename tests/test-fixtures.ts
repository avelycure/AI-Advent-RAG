import {
  CHUNKER_VERSION,
  INDEX_SCHEMA_VERSION,
  type ChunkingComparison,
  type IndexedChunk,
  type VectorIndexSnapshot,
} from '../src/types';

export const TEST_COMPARISON: ChunkingComparison = {
  documentCount: 1,
  sourceCharacters: 100,
  estimatedPages: 0.1,
  structureChunkingUnit: 'section',
  fixedSize: {
    strategy: 'fixed-size',
    chunkCount: 1,
    averageCharacters: 100,
    p95Characters: 100,
    sectionMetadataPercent: 0,
  },
  structureAware: {
    strategy: 'structure-aware',
    chunkCount: 1,
    averageCharacters: 100,
    p95Characters: 100,
    sectionMetadataPercent: 100,
  },
};

export function indexedChunk(
  chunk_id: string,
  vector: number[] = [1, 0],
  overrides: Partial<IndexedChunk> = {},
): IndexedChunk {
  return {
    ordinal: 0,
    text: chunk_id,
    contentHash: chunk_id,
    metadata: {
      source: `${chunk_id}.md`,
      title: chunk_id,
      section: null,
      chunk_id,
      line_start: 1,
      line_end: 1,
      file_mtime: 1,
    },
    vector,
    ...overrides,
  };
}

export function indexSnapshot(
  chunks: IndexedChunk[],
  overrides: Partial<VectorIndexSnapshot> = {},
): VectorIndexSnapshot {
  return {
    schemaVersion: INDEX_SCHEMA_VERSION,
    chunkerVersion: CHUNKER_VERSION,
    embeddingModel: 'qwen3-embedding:0.6b',
    embeddingFingerprint: 'digest',
    vectorDimension: 2,
    builtAt: 1,
    scopeSignature: 'all:',
    chunkingStrategy: 'structure-aware',
    structureChunkingUnit: 'section',
    fixedChunkSize: 3200,
    chunkingComparison: TEST_COMPARISON,
    chunks,
    ...overrides,
  };
}
