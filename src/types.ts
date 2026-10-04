export const EMBEDDING_MODEL = 'qwen3-embedding:0.6b' as const;
export const OLLAMA_BASE_URL = 'http://127.0.0.1:11434' as const;
export const INDEX_SCHEMA_VERSION = 5 as const;
export const CHUNKER_VERSION = 3 as const;
export const DEFAULT_FIXED_CHUNK_SIZE = 3200 as const;
export const MIN_FIXED_CHUNK_SIZE = 256 as const;
export const MAX_FIXED_CHUNK_SIZE = 20_000 as const;

export type FolderMode = 'all' | 'include' | 'exclude';
export type LlmProviderId = 'ollama' | 'openai' | 'deepseek' | 'glm' | 'custom';
export type ChunkingStrategy = 'fixed-size' | 'structure-aware';
export type StructureChunkingUnit = 'paragraph' | 'section' | 'file';
export type IndexStorageFormat = 'binary' | 'json' | 'sqlite' | 'faiss';

export interface PluginSettings {
  folderMode: FolderMode;
  selectedFolders: string[];
  chunkingStrategy: ChunkingStrategy;
  structureChunkingUnit: StructureChunkingUnit;
  fixedChunkSize: number;
  indexStorageFormat: IndexStorageFormat;
  activeIndexStorageFormat: IndexStorageFormat;
  llmProvider: LlmProviderId;
  llmBaseUrl: string;
  llmModel: string;
  llmApiKeySecretId: string;
  topK: number;
  lastIndexedAt: number | null;
  indexNeedsRebuild: boolean;
}

export interface SourceDocument {
  path: string;
  title?: string;
  content: string;
  mtime: number;
}

export interface ChunkMetadata {
  source: string;
  title: string;
  section: string | null;
  chunk_id: string;
  line_start: number;
  line_end: number;
  file_mtime: number;
}

export interface TextChunk {
  ordinal: number;
  text: string;
  contentHash: string;
  metadata: ChunkMetadata;
}

export interface IndexedChunk extends TextChunk {
  vector: number[] | Float32Array;
}

export interface VectorIndexSnapshot {
  schemaVersion: number;
  chunkerVersion: number;
  embeddingModel: string;
  embeddingFingerprint: string;
  vectorDimension: number;
  builtAt: number;
  scopeSignature: string;
  chunkingStrategy: ChunkingStrategy;
  structureChunkingUnit: StructureChunkingUnit;
  fixedChunkSize: number;
  chunkingComparison: ChunkingComparison;
  chunks: IndexedChunk[];
}

export interface ChunkingMetrics {
  strategy: ChunkingStrategy;
  chunkCount: number;
  averageCharacters: number;
  p95Characters: number;
  sectionMetadataPercent: number;
}

export interface ChunkingComparison {
  documentCount: number;
  sourceCharacters: number;
  estimatedPages: number;
  structureChunkingUnit: StructureChunkingUnit;
  fixedSize: ChunkingMetrics;
  structureAware: ChunkingMetrics;
}

export interface SearchResult {
  chunk: IndexedChunk;
  score: number;
  sourceId: string;
}

export interface IndexProgress {
  phase: 'reading' | 'embedding' | 'saving';
  completed: number;
  total: number;
  currentPath?: string;
}

export interface LlmConfig {
  provider: LlmProviderId;
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmClient {
  generate(messages: LlmMessage[], config: LlmConfig): Promise<string>;
  testConnection(config: LlmConfig): Promise<void>;
}

export interface EmbeddingClient {
  embed(input: string[]): Promise<number[][]>;
  testConnection(): Promise<void>;
  getFingerprint(): Promise<string>;
}

export interface IndexRepository {
  readonly format: IndexStorageFormat;
  load(): Promise<VectorIndexSnapshot | null>;
  save(snapshot: VectorIndexSnapshot): Promise<void>;
  search?(queryVector: number[], topK: number): Promise<VectorSearchHit[]>;
}

export interface VectorSearchHit {
  index: number;
  score: number;
}

export interface RagAnswer {
  text: string;
  sources: SearchResult[];
}

export interface RetrievalResponse {
  query: string;
  strategy: ChunkingStrategy;
  results: SearchResult[];
}
