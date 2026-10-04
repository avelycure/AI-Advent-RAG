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
  ollama: 'qwen3:8b',
  openai: '',
  deepseek: 'deepseek-flash',
  glm: '',
  custom: '',
};

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
  llmApiKeySecretId: '',
  topK: 10,
  lastIndexedAt: null,
  indexNeedsRebuild: true,
};

export function sanitizeSettings(value: unknown): PluginSettings {
  const raw = isRecord(value) ? value : {};
  const folderMode: PluginSettings['folderMode'] =
    raw.folderMode === 'include' || raw.folderMode === 'exclude' ? raw.folderMode : 'all';
  const llmProvider: PluginSettings['llmProvider'] =
    typeof raw.llmProvider === 'string' &&
    Object.prototype.hasOwnProperty.call(PROVIDER_BASE_URLS, raw.llmProvider)
      ? (raw.llmProvider as PluginSettings['llmProvider'])
      : 'ollama';
  const selectedFolders = Array.isArray(raw.selectedFolders)
    ? raw.selectedFolders.filter((folder): folder is string => typeof folder === 'string')
    : [];
  const lastIndexedAt =
    typeof raw.lastIndexedAt === 'number' && Number.isFinite(raw.lastIndexedAt)
      ? raw.lastIndexedAt
      : null;

  return {
    folderMode,
    llmProvider,
    selectedFolders: normalizeFolderList(selectedFolders),
    chunkingStrategy: raw.chunkingStrategy === 'structure-aware' ? 'structure-aware' : 'fixed-size',
    structureChunkingUnit: sanitizeStructureChunkingUnit(raw.structureChunkingUnit),
    fixedChunkSize: sanitizeFixedChunkSize(raw.fixedChunkSize),
    indexStorageFormat: sanitizeStorageFormat(raw.indexStorageFormat),
    activeIndexStorageFormat: sanitizeStorageFormat(raw.activeIndexStorageFormat),
    llmBaseUrl:
      typeof raw.llmBaseUrl === 'string' ? raw.llmBaseUrl : PROVIDER_BASE_URLS[llmProvider],
    llmModel:
      typeof raw.llmModel === 'string' ? raw.llmModel : PROVIDER_DEFAULT_MODELS[llmProvider],
    llmApiKeySecretId:
      typeof raw.llmApiKeySecretId === 'string' ? raw.llmApiKeySecretId : '',
    topK: Math.max(1, Math.min(20, Math.round(Number(raw.topK) || DEFAULT_SETTINGS.topK))),
    lastIndexedAt,
    indexNeedsRebuild:
      typeof raw.indexNeedsRebuild === 'boolean' ? raw.indexNeedsRebuild : true,
  };
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
