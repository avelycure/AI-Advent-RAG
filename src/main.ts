import { FileSystemAdapter, MarkdownView, Notice, Plugin, TFile, WorkspaceLeaf } from 'obsidian';
import { join } from 'node:path';
import { OllamaEmbeddingClient } from './embeddings/ollama-embedding-client';
import { IndexController } from './indexing/index-controller';
import {
  createIndexRepository,
  storageFormatLabel,
} from './indexing/index-repository-factory';
import { ensureIndexDirectory, indexDirectoryPath } from './indexing/index-paths';
import { discoverFolders, scopeSignature } from './indexing/folder-scope';
import { ObsidianHttpTransport } from './infrastructure/obsidian-http-transport';
import { RetrievalService } from './retrieval/retrieval-service';
import { DEFAULT_SETTINGS, sanitizeSettings } from './settings/defaults';
import { AiAdventRagSettingsTab } from './settings/settings-tab';
import { CHAT_VIEW_TYPE, ChatView } from './ui/chat-view';
import type {
  ChunkingComparison,
  IndexProgress,
  PluginSettings,
  RetrievalResponse,
  SearchResult,
  StructureChunkingUnit,
} from './types';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

export default class AiAdventRagPlugin extends Plugin {
  settings: PluginSettings = { ...DEFAULT_SETTINGS };
  private indexController!: IndexController;
  private retrievalService!: RetrievalService;
  private changeRevision = 0;

  async onload(): Promise<void> {
    this.settings = sanitizeSettings(await this.loadData());
    await ensureIndexDirectory(this.pluginDirectoryPath());
    const transport = new ObsidianHttpTransport();
    const embeddings = new OllamaEmbeddingClient(transport);
    this.retrievalService = new RetrievalService(embeddings);
    this.indexController = new IndexController(
      this.app,
      embeddings,
      createIndexRepository(this.indexDirectoryPath(), this.settings.activeIndexStorageFormat),
    );

    try {
      await this.indexController.load();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
      this.settings.indexNeedsRebuild = true;
    }

    this.registerView(CHAT_VIEW_TYPE, (leaf) => new ChatView(leaf, this));
    this.addRibbonIcon('search', 'Search indexed notes', () => {
      void this.activateChatView();
    });
    this.addCommand({
      id: 'open-question-panel',
      name: 'Open semantic search panel',
      callback: () => void this.activateChatView(),
    });
    this.addCommand({
      id: 'rebuild-index',
      name: 'Rebuild local semantic index',
      callback: () => void this.rebuildIndexWithNotices(),
    });
    this.addSettingTab(new AiAdventRagSettingsTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      this.registerVaultChangeTracking();
      void this.runScheduledRebuildIfDue(true);
    });
    this.registerInterval(
      window.setInterval(() => void this.runScheduledRebuildIfDue(), CHECK_INTERVAL_MS),
    );
  }

  async saveSettings(): Promise<void> {
    this.settings = sanitizeSettings(this.settings);
    await this.saveData(this.settings);
  }

  indexSummary(): string {
    const snapshot = this.indexController?.getSnapshot();
    if (!snapshot) return 'Индекс ещё не создан.';
    const date = new Date(snapshot.builtAt).toLocaleString();
    const stale = this.settings.indexNeedsRebuild
      ? ' Настройки или заметки изменились — требуется перестроение.'
      : '';
    const activeFormat = storageFormatLabel(this.settings.activeIndexStorageFormat);
    const pendingFormat = this.settings.indexStorageFormat !== this.settings.activeIndexStorageFormat
      ? ` Выбран формат ${storageFormatLabel(this.settings.indexStorageFormat)}; он вступит в силу после успешного перестроения.`
      : '';
    const strategy = snapshot.chunkingStrategy === 'fixed-size'
      ? `фиксированный размер ${snapshot.fixedChunkSize} символов`
      : `по структуре: ${structureChunkingUnitLabel(snapshot.structureChunkingUnit)}`;
    return `${snapshot.chunks.length} фрагментов, формат: ${activeFormat}, разбиение: ${strategy}. Индекс создан ${date}.${pendingFormat}${stale}`;
  }

  chunkingComparison(): ChunkingComparison | null {
    return this.indexController?.getSnapshot()?.chunkingComparison ?? null;
  }

  isIndexRebuilding(): boolean {
    return this.indexController.isRebuilding();
  }

  availableFolders(): string[] {
    return discoverFolders(this.app.vault.getMarkdownFiles().map((file) => file.path));
  }

  markIndexDirty(): void {
    this.changeRevision += 1;
    this.settings.indexNeedsRebuild = true;
  }

  async rebuildIndexWithNotices(): Promise<void> {
    const revisionAtStart = this.changeRevision;
    const settingsAtStart: PluginSettings = {
      ...this.settings,
      selectedFolders: [...this.settings.selectedFolders],
    };
    let lastPercent = -1;
    const progress = (value: IndexProgress): void => {
      const percent = value.total === 0 ? 100 : Math.floor((value.completed / value.total) * 100);
      if (percent >= lastPercent + 20) {
        lastPercent = percent;
        const label = value.phase === 'reading'
          ? 'Чтение заметок'
          : value.phase === 'embedding'
            ? 'Создание векторов'
            : 'Сохранение индекса';
        new Notice(`${label}: ${percent}%`);
      }
    };

    try {
      const targetRepository = createIndexRepository(
        this.indexDirectoryPath(),
        settingsAtStart.indexStorageFormat,
      );
      const snapshot = await this.indexController.rebuild(settingsAtStart, progress, targetRepository);
      this.settings.activeIndexStorageFormat = settingsAtStart.indexStorageFormat;
      this.settings.lastIndexedAt = snapshot.builtAt;
      this.settings.indexNeedsRebuild =
        revisionAtStart !== this.changeRevision ||
        snapshot.scopeSignature !== this.currentScopeSignature() ||
        snapshot.chunkingStrategy !== this.settings.chunkingStrategy ||
        snapshot.structureChunkingUnit !== this.settings.structureChunkingUnit ||
        snapshot.fixedChunkSize !== this.settings.fixedChunkSize;
      await this.saveSettings();
      new Notice(`Индекс перестроен: ${snapshot.chunks.length} фрагментов.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Не удалось перестроить индекс: ${message}`);
      throw error;
    }
  }

  async search(query: string): Promise<RetrievalResponse> {
    const snapshot = this.indexController.getSnapshot();
    if (!snapshot) throw new Error('Build the local index in plugin settings first.');
    if (
      snapshot.scopeSignature !== this.currentScopeSignature() ||
      snapshot.chunkingStrategy !== this.settings.chunkingStrategy ||
      snapshot.structureChunkingUnit !== this.settings.structureChunkingUnit ||
      snapshot.fixedChunkSize !== this.settings.fixedChunkSize
    ) {
      throw new Error('The index settings changed. Rebuild the index before searching.');
    }
    return this.retrievalService.search(
      query,
      snapshot,
      this.settings.topK,
      (queryVector, topK) => this.indexController.searchVector(queryVector, topK),
    );
  }

  async openSource(source: SearchResult): Promise<void> {
    const file = this.app.vault.getFileByPath(source.chunk.metadata.source);
    if (!file) {
      throw new Error(`Source note no longer exists: ${source.chunk.metadata.source}`);
    }
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file);
    if (leaf.view instanceof MarkdownView) {
      const position = { line: Math.max(0, source.chunk.metadata.line_start - 1), ch: 0 };
      leaf.view.editor.setCursor(position);
      leaf.view.editor.scrollIntoView({ from: position, to: position }, true);
    }
  }

  private async activateChatView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0];
    const leaf = existing ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) throw new Error('Could not open the AI Advent RAG panel.');
    if (!existing) await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  private indexDirectoryPath(): string {
    return indexDirectoryPath(this.pluginDirectoryPath());
  }

  private pluginDirectoryPath(): string {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error('AI Advent RAG requires the Obsidian desktop file-system adapter.');
    }
    return join(adapter.getBasePath(), this.app.vault.configDir, 'plugins', this.manifest.id);
  }

  private currentScopeSignature(): string {
    return scopeSignature({
      mode: this.settings.folderMode,
      folders: this.settings.selectedFolders,
    });
  }

  private registerVaultChangeTracking(): void {
    const markDirty = (file: unknown): void => {
      if (!(file instanceof TFile) || file.extension !== 'md') return;
      this.markIndexDirty();
      void this.saveSettings();
    };
    this.registerEvent(this.app.vault.on('create', markDirty));
    this.registerEvent(this.app.vault.on('modify', markDirty));
    this.registerEvent(this.app.vault.on('delete', markDirty));
    this.registerEvent(this.app.vault.on('rename', markDirty));
  }

  private async runScheduledRebuildIfDue(catchUp = false): Promise<void> {
    if (this.indexController.isRebuilding()) return;
    if (this.settings.lastIndexedAt === null) return;
    const lastIndexedAt = this.settings.lastIndexedAt;
    if (Date.now() - lastIndexedAt < WEEK_MS) return;
    const hour = new Date().getHours();
    if (!catchUp && (hour < 2 || hour >= 5)) return;
    const revisionAtStart = this.changeRevision;
    const settingsAtStart: PluginSettings = {
      ...this.settings,
      selectedFolders: [...this.settings.selectedFolders],
    };
    try {
      new Notice('AI Advent RAG обновляет еженедельный локальный индекс.');
      const targetRepository = createIndexRepository(
        this.indexDirectoryPath(),
        settingsAtStart.indexStorageFormat,
      );
      const snapshot = await this.indexController.update(settingsAtStart, undefined, targetRepository);
      this.settings.activeIndexStorageFormat = settingsAtStart.indexStorageFormat;
      this.settings.lastIndexedAt = snapshot.builtAt;
      this.settings.indexNeedsRebuild =
        revisionAtStart !== this.changeRevision ||
        snapshot.scopeSignature !== this.currentScopeSignature() ||
        snapshot.chunkingStrategy !== this.settings.chunkingStrategy ||
        snapshot.structureChunkingUnit !== this.settings.structureChunkingUnit ||
        snapshot.fixedChunkSize !== this.settings.fixedChunkSize;
      await this.saveSettings();
      new Notice(`Еженедельное обновление индекса завершено: ${snapshot.chunks.length} фрагментов.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Не удалось обновить еженедельный индекс: ${message}`);
    }
  }
}

function structureChunkingUnitLabel(unit: StructureChunkingUnit): string {
  switch (unit) {
    case 'paragraph':
      return 'абзацы';
    case 'section':
      return 'разделы Markdown';
    case 'file':
      return 'файлы';
  }
}

declare module 'obsidian' {
  interface Workspace {
    getRightLeaf(split: boolean): WorkspaceLeaf | null;
  }
}
