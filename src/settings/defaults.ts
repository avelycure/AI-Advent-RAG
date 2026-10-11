import {
  DEFAULT_FIXED_CHUNK_SIZE,
  MAX_FIXED_CHUNK_SIZE,
  MIN_FIXED_CHUNK_SIZE,
  type LlmProviderId,
  type PluginSettings,
} from '../types';

export const PROVIDER_BASE_URLS: Record<LlmProviderId, string> = {
  ollama: 'http://127.0.0.1:11434',
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com',
  glm: 'https://api.z.ai/api/paas/v4',
  custom: '',
};

export const PROVIDER_DEFAULT_MODELS: Record<LlmProviderId, string> = {
  ollama: 'qwen3.8:27b',
  openai: 'gpt-5.4-mini-2026-03-17',
  deepseek: 'deepseek-flash',
  glm: 'glm-5.3',
  custom: '',
};

export const DEFAULT_RETRIEVAL_CANDIDATE_TOP_K = 20;
export const DEFAULT_RETRIEVAL_FINAL_TOP_K = 5;
export const DEFAULT_SIMILARITY_THRESHOLD = 0.35;
export const MIN_RETRIEVAL_CANDIDATE_TOP_K = 3;
export const MAX_RETRIEVAL_CANDIDATE_TOP_K = 50;
export const MIN_RETRIEVAL_FINAL_TOP_K = 1;
export const MAX_RETRIEVAL_FINAL_TOP_K = 20;

export const DEFAULT_SETTINGS: PluginSettings = {
  folderMode: 'all',
  selectedFolders: [],
  chunkingStrategy: 'fixed-size',
  structureChunkingUnit: 'section',
  fixedChunkSize: DEFAULT_FIXED_CHUNK_SIZE,
  indexStorageFormat: 'binary',
  activeIndexStorageFormat: 'binary',
  llmProvider: 'ollama',
  llmBaseUrl: PROVIDER_BASE_URLS.ollama,
  llmModel: PROVIDER_DEFAULT_MODELS.ollama,
  llmApiKeySecretId: 'ai-advent-rag-deepseek',
  retrievalCandidateTopK: DEFAULT_RETRIEVAL_CANDIDATE_TOP_K,
  retrievalFinalTopK: DEFAULT_RETRIEVAL_FINAL_TOP_K,
  similarityThreshold: DEFAULT_SIMILARITY_THRESHOLD,
  lastIndexedAt: null,
  indexNeedsRebuild: true,
};

export function sanitizeSettings(value: unknown): PluginSettings {
  const raw = isRecord(value) ? value : {};
  const folderMode: PluginSettings['folderMode'] =
    raw.folderMode === 'include' || raw.folderMode === 'exclude' ? raw.folderMode : 'all';
  const llmProvider: PluginSettings['llmProvider'] = 'ollama';
  const selectedFolders = Array.isArray(raw.selectedFolders)
    ? raw.selectedFolders.filter((folder): folder is string => typeof folder === 'string')
    : [];
  const lastIndexedAt =
    typeof raw.lastIndexedAt === 'number' && Number.isFinite(raw.lastIndexedAt)
      ? raw.lastIndexedAt
      : null;
  const retrievalCandidateTopK = clampInteger(
    raw.retrievalCandidateTopK,
    MIN_RETRIEVAL_CANDIDATE_TOP_K,
    MAX_RETRIEVAL_CANDIDATE_TOP_K,
    DEFAULT_RETRIEVAL_CANDIDATE_TOP_K,
  );
  const retrievalFinalTopK = Math.min(
    retrievalCandidateTopK,
    clampInteger(
      raw.retrievalFinalTopK,
      MIN_RETRIEVAL_FINAL_TOP_K,
      MAX_RETRIEVAL_FINAL_TOP_K,
      DEFAULT_RETRIEVAL_FINAL_TOP_K,
    ),
  );

  return {
    folderMode,
    llmProvider,
    selectedFolders: normalizeFolderList(selectedFolders),
    chunkingStrategy: raw.chunkingStrategy === 'structure-aware' ? 'structure-aware' : 'fixed-size',
    structureChunkingUnit: sanitizeStructureChunkingUnit(raw.structureChunkingUnit),
    fixedChunkSize: sanitizeFixedChunkSize(raw.fixedChunkSize),
    indexStorageFormat: sanitizeStorageFormat(raw.indexStorageFormat),
    activeIndexStorageFormat: sanitizeStorageFormat(raw.activeIndexStorageFormat),
    llmBaseUrl: PROVIDER_BASE_URLS.ollama,
    llmModel:
      typeof raw.llmModel === 'string' && raw.llmProvider === 'ollama' && raw.llmModel.trim()
        ? raw.llmModel.trim()
        : PROVIDER_DEFAULT_MODELS.ollama,
    llmApiKeySecretId: 'ai-advent-rag-deepseek',
    retrievalCandidateTopK,
    retrievalFinalTopK,
    similarityThreshold: sanitizeSimilarityThreshold(raw.similarityThreshold),
    lastIndexedAt,
    indexNeedsRebuild:
      typeof raw.indexNeedsRebuild === 'boolean' ? raw.indexNeedsRebuild : true,
  };
}

function clampInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(parsed)));
}

function sanitizeSimilarityThreshold(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_SIMILARITY_THRESHOLD;
  return Math.max(0, Math.min(1, Math.round(parsed * 100) / 100));
}

function sanitizeStructureChunkingUnit(
  value: unknown,
): PluginSettings['structureChunkingUnit'] {
  return value === 'paragraph' || value === 'file' ? value : 'section';
}

function sanitizeStorageFormat(value: unknown): PluginSettings['indexStorageFormat'] {
  return value === 'json' || value === 'sqlite' || value === 'faiss' ? value : 'binary';
}

function sanitizeFixedChunkSize(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_FIXED_CHUNK_SIZE;
  return Math.max(MIN_FIXED_CHUNK_SIZE, Math.min(MAX_FIXED_CHUNK_SIZE, Math.round(parsed)));
}

export function normalizeFolderList(folders: readonly string[]): string[] {
  return [...new Set(folders.map(normalizeFolder).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
}

export function normalizeFolder(folder: string): string {
  return folder
    .trim()
    .replaceAll('\\', '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

export function isValidFolderPath(folder: string): boolean {
  if (!folder) return false;
  return folder.split('/').every((segment) => segment !== '.' && segment !== '..');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
