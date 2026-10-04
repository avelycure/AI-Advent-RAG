import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  isValidFolderPath,
  normalizeFolder,
  sanitizeSettings,
} from '../src/settings/defaults';

describe('settings sanitization', () => {
  it('falls back safely when persisted data has an invalid shape', () => {
    const settings = sanitizeSettings({
      folderMode: 'unknown',
      selectedFolders: 'Private',
      llmProvider: 'unknown',
      topK: Number.NaN,
      lastIndexedAt: 'yesterday',
    });

    expect(settings).toEqual(DEFAULT_SETTINGS);
  });

  it('normalizes folder lists and clamps retrieval count', () => {
    const settings = sanitizeSettings({
      folderMode: 'exclude',
      selectedFolders: ['/Private/', 'Private', 42],
      llmProvider: 'deepseek',
      llmBaseUrl: 'https://example.com/v1',
      llmModel: 'test-model',
      llmApiKeySecretId: 'secret-id',
      fixedChunkSize: 512.6,
      retrievalCandidateTopK: 100,
      lastIndexedAt: 123,
      indexNeedsRebuild: false,
    });

    expect(settings.selectedFolders).toEqual(['Private']);
    expect(settings.retrievalCandidateTopK).toBe(50);
    expect(settings.retrievalFinalTopK).toBe(5);
    expect(settings.fixedChunkSize).toBe(513);
    expect(settings.lastIndexedAt).toBe(123);
    expect(settings.indexNeedsRebuild).toBe(false);
  });

  it('uses fixed-size chunking by default and clamps its configured size', () => {
    expect(DEFAULT_SETTINGS.chunkingStrategy).toBe('fixed-size');
    expect(DEFAULT_SETTINGS.structureChunkingUnit).toBe('section');
    expect(DEFAULT_SETTINGS.fixedChunkSize).toBe(3200);
    expect(sanitizeSettings({ fixedChunkSize: 12 }).fixedChunkSize).toBe(256);
    expect(sanitizeSettings({ fixedChunkSize: 50_000 }).fixedChunkSize).toBe(20_000);
  });

  it('uses DeepSeek with RAG by default and preserves only a boolean RAG switch', () => {
    expect(DEFAULT_SETTINGS.llmProvider).toBe('deepseek');
    expect(DEFAULT_SETTINGS.llmBaseUrl).toBe('https://api.deepseek.com');
    expect(DEFAULT_SETTINGS.llmModel).toBe('deepseek-flash');
    expect(DEFAULT_SETTINGS.useRag).toBe(true);
    expect(DEFAULT_SETTINGS.useRetrievalEnhancements).toBe(true);
    expect(DEFAULT_SETTINGS.similarityThreshold).toBe(0.35);
    expect(sanitizeSettings({ useRag: false }).useRag).toBe(false);
    expect(sanitizeSettings({ useRag: 'false' }).useRag).toBe(true);
    expect(sanitizeSettings({ llmApiKeySecretId: 'untrusted-id' }).llmApiKeySecretId).toBe(
      'ai-advent-rag-deepseek',
    );
  });

  it('sanitizes filtering limits and ignores the obsolete topK setting', () => {
    const migrated = sanitizeSettings({ topK: 12 });
    expect(migrated.retrievalCandidateTopK).toBe(20);
    expect(migrated.retrievalFinalTopK).toBe(5);

    const settings = sanitizeSettings({
      retrievalCandidateTopK: 3,
      retrievalFinalTopK: 20,
      similarityThreshold: 1.234,
      useRetrievalEnhancements: false,
    });
    expect(settings.retrievalCandidateTopK).toBe(3);
    expect(settings.retrievalFinalTopK).toBe(3);
    expect(settings.similarityThreshold).toBe(1);
    expect(settings.useRetrievalEnhancements).toBe(false);
  });

  it('supports paragraph, section, and file structural units', () => {
    expect(sanitizeSettings({ structureChunkingUnit: 'paragraph' }).structureChunkingUnit).toBe(
      'paragraph',
    );
    expect(sanitizeSettings({ structureChunkingUnit: 'section' }).structureChunkingUnit).toBe(
      'section',
    );
    expect(sanitizeSettings({ structureChunkingUnit: 'file' }).structureChunkingUnit).toBe('file');
    expect(sanitizeSettings({ structureChunkingUnit: 'unknown' }).structureChunkingUnit).toBe(
      'section',
    );
  });

  it('supports four storage formats and rejects unknown persisted values', () => {
    expect(DEFAULT_SETTINGS.indexStorageFormat).toBe('binary');
    expect(sanitizeSettings({ indexStorageFormat: 'json' }).indexStorageFormat).toBe('json');
    expect(sanitizeSettings({ indexStorageFormat: 'sqlite' }).indexStorageFormat).toBe('sqlite');
    expect(sanitizeSettings({ indexStorageFormat: 'faiss' }).indexStorageFormat).toBe('faiss');
    expect(sanitizeSettings({ indexStorageFormat: 'unknown' }).indexStorageFormat).toBe('binary');
  });

  it('normalizes manually entered folder paths and rejects traversal segments', () => {
    expect(normalizeFolder(' /Проекты\\2026//RAG/ ')).toBe('Проекты/2026/RAG');
    expect(isValidFolderPath('Проекты/2026')).toBe(true);
    expect(isValidFolderPath('')).toBe(false);
    expect(isValidFolderPath('../Личное')).toBe(false);
    expect(isValidFolderPath('Проекты/../Личное')).toBe(false);
  });
});
