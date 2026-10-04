import type { App, TFile } from 'obsidian';
import { isPathInScope, scopeSignature } from './folder-scope';
import { buildIndex, compareChunking } from './index-builder';
import type {
  EmbeddingClient,
  IndexProgress,
  IndexRepository,
  PluginSettings,
  SourceDocument,
  VectorIndexSnapshot,
  VectorSearchHit,
} from '../types';
import { CHUNKER_VERSION, EMBEDDING_MODEL, INDEX_SCHEMA_VERSION } from '../types';

export class IndexController {
  private snapshot: VectorIndexSnapshot | null = null;
  private rebuilding = false;

  constructor(
    private readonly app: App,
    private readonly embeddings: EmbeddingClient,
    private repository: IndexRepository,
  ) {}

  async load(): Promise<void> {
    this.snapshot = await this.repository.load();
    if (
      this.snapshot &&
      (this.snapshot.schemaVersion !== INDEX_SCHEMA_VERSION ||
        this.snapshot.chunkerVersion !== CHUNKER_VERSION ||
        this.snapshot.embeddingModel !== EMBEDDING_MODEL)
    ) {
      this.snapshot = null;
      throw new Error('Локальный индекс создан несовместимой версией. Перестройте его.');
    }
  }

  getSnapshot(): VectorIndexSnapshot | null {
    return this.snapshot;
  }

  isRebuilding(): boolean {
    return this.rebuilding;
  }

  async rebuild(
    settings: PluginSettings,
    onProgress?: (progress: IndexProgress) => void,
    targetRepository: IndexRepository = this.repository,
  ): Promise<VectorIndexSnapshot> {
    if (this.rebuilding) throw new Error('Перестроение индекса уже выполняется.');
    this.rebuilding = true;
    try {
      await this.embeddings.testConnection();
      return await this.rebuildFromScratch(settings, onProgress, targetRepository);
    } finally {
      this.rebuilding = false;
    }
  }

  async update(
    settings: PluginSettings,
    onProgress?: (progress: IndexProgress) => void,
    targetRepository: IndexRepository = this.repository,
  ): Promise<VectorIndexSnapshot> {
    const existing = this.snapshot;
    const scope = { mode: settings.folderMode, folders: settings.selectedFolders };
    const signature = scopeSignature(scope);
    if (
      !existing ||
      targetRepository.format !== this.repository.format ||
      existing.scopeSignature !== signature ||
      existing.chunkingStrategy !== settings.chunkingStrategy ||
      existing.structureChunkingUnit !== settings.structureChunkingUnit ||
      existing.fixedChunkSize !== settings.fixedChunkSize
    ) {
      return this.rebuild(settings, onProgress, targetRepository);
    }
    if (this.rebuilding) throw new Error('Обновление индекса уже выполняется.');
    this.rebuilding = true;
    try {
      await this.embeddings.testConnection();
      const currentFingerprint = await this.embeddings.getFingerprint();
      if (currentFingerprint !== existing.embeddingFingerprint) {
        return await this.rebuildFromScratch(settings, onProgress, targetRepository);
      }
      const files = this.app.vault
        .getMarkdownFiles()
        .filter((file) => isPathInScope(file.path, scope));
      const currentMtime = new Map(files.map((file) => [file.path, file.stat.mtime]));
      const indexedMtime = new Map<string, number>();
      for (const chunk of existing.chunks) {
        indexedMtime.set(chunk.metadata.source, chunk.metadata.file_mtime);
      }

      const changedFiles = files.filter((file) => indexedMtime.get(file.path) !== file.stat.mtime);
      const changedPaths = new Set(changedFiles.map((file) => file.path));
      const unchangedChunks = existing.chunks.filter(
        (chunk) =>
          currentMtime.has(chunk.metadata.source) && !changedPaths.has(chunk.metadata.source),
      );
      const partial = await buildIndex(this.readDocuments(changedFiles), this.embeddings, {
        scopeSignature: signature,
        chunkingStrategy: settings.chunkingStrategy,
        structureChunkingUnit: settings.structureChunkingUnit,
        fixedChunkSize: settings.fixedChunkSize,
        totalDocuments: changedFiles.length,
        onProgress,
      });
      if (
        partial.vectorDimension > 0 &&
        existing.vectorDimension > 0 &&
        partial.vectorDimension !== existing.vectorDimension
      ) {
        throw new Error('Формат векторов embedding-модели изменился. Полностью перестройте индекс.');
      }

      const snapshot: VectorIndexSnapshot = {
        ...existing,
        builtAt: Date.now(),
        chunks: [...unchangedChunks, ...partial.chunks],
        vectorDimension: existing.vectorDimension || partial.vectorDimension,
        chunkingComparison: await compareChunking(
          this.readDocuments(files),
          settings.fixedChunkSize,
          settings.structureChunkingUnit,
        ),
      };
      onProgress?.({ phase: 'saving', completed: 0, total: 1 });
      await targetRepository.save(snapshot);
      onProgress?.({ phase: 'saving', completed: 1, total: 1 });
      this.snapshot = snapshot;
      this.repository = targetRepository;
      return snapshot;
    } finally {
      this.rebuilding = false;
    }
  }

  async searchVector(queryVector: number[], topK: number): Promise<VectorSearchHit[] | null> {
    return this.repository.search?.(queryVector, topK) ?? null;
  }

  private async rebuildFromScratch(
    settings: PluginSettings,
    onProgress?: (progress: IndexProgress) => void,
    targetRepository: IndexRepository = this.repository,
  ): Promise<VectorIndexSnapshot> {
    const scope = { mode: settings.folderMode, folders: settings.selectedFolders };
    const files = this.app.vault
      .getMarkdownFiles()
      .filter((file) => isPathInScope(file.path, scope));
    const snapshot = await buildIndex(this.readDocuments(files), this.embeddings, {
      scopeSignature: scopeSignature(scope),
      chunkingStrategy: settings.chunkingStrategy,
      structureChunkingUnit: settings.structureChunkingUnit,
      fixedChunkSize: settings.fixedChunkSize,
      totalDocuments: files.length,
      onProgress,
    });
    onProgress?.({ phase: 'saving', completed: 0, total: 1 });
    await targetRepository.save(snapshot);
    onProgress?.({ phase: 'saving', completed: 1, total: 1 });
    this.snapshot = snapshot;
    this.repository = targetRepository;
    return snapshot;
  }

  private async *readDocuments(files: readonly TFile[]): AsyncGenerator<SourceDocument> {
    for (const file of files) {
      const mtime = file.stat.mtime;
      yield {
        path: file.path,
        title: file.basename,
        content: await this.app.vault.cachedRead(file),
        mtime,
      };
    }
  }
}
