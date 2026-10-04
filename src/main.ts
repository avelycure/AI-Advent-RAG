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
import { NodeHttpsTransport } from './infrastructure/node-https-transport';
import { ConfigurableLlmClient, DEEPSEEK_API_BASE_URL } from './llm/llm-client';
import { RagService } from './rag/rag-service';
import { validateIndexSnapshot } from './rag/validate-index-snapshot';
import { RetrievalService } from './retrieval/retrieval-service';
import { DEFAULT_SETTINGS, sanitizeSettings } from './settings/defaults';
import { AiAdventRagSettingsTab } from './settings/settings-tab';
import { CHAT_VIEW_TYPE, ChatView } from './ui/chat-view';
import { ChatStateRepository } from './ui/chat-state-repository';
import type { ChatState } from './ui/chat-state';
import type {
  ChunkingComparison,
  ChatTurn,
  IndexProgress,
  PluginSettings,
  RagAnswer,
  RetrievalResponse,
  SearchResult,
  StructureChunkingUnit,
  TaskMemory,
} from './types';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

export default class AiAdventRagPlugin extends Plugin {
  settings: PluginSettings = { ...DEFAULT_SETTINGS };
  private indexController!: IndexController;
  private retrievalService!: RetrievalService;
  private ragService!: RagService;
  private llmClient!: ConfigurableLlmClient;
  private chatStateRepository!: ChatStateRepository;
  private changeRevision = 0;

  async onload(): Promise<void> {
    this.settings = sanitizeSettings(await this.loadData());
    const pluginDirectory = this.pluginDirectoryPath();
    await ensureIndexDirectory(pluginDirectory);
    this.chatStateRepository = new ChatStateRepository(pluginDirectory);
    const transport = new ObsidianHttpTransport();
    const embeddings = new OllamaEmbeddingClient(transport);
    this.llmClient = new ConfigurableLlmClient(new NodeHttpsTransport(DEEPSEEK_API_BASE_URL));
    this.retrievalService = new RetrievalService(embeddings);
    this.ragService = new RagService(embeddings, this.llmClient);
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
    this.addRibbonIcon('message-circle', 'Открыть чат с DeepSeek', () => {
      void this.activateChatView();
    });
    this.addCommand({
      id: 'open-question-panel',
      name: 'Открыть чат с DeepSeek',
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
      this.refreshChatViews();
      new Notice(`Индекс перестроен: ${snapshot.chunks.length} фрагментов.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Не удалось перестроить индекс: ${message}`);
      throw error;
    }
  }

  async search(query: string): Promise<RetrievalResponse> {
    const snapshot = this.validatedSnapshot();
    const useEnhancements = this.settings.useRetrievalEnhancements;
    return this.retrievalService.search(
      query,
      snapshot,
      {
        candidateTopK: useEnhancements
          ? this.settings.retrievalCandidateTopK
          : this.settings.retrievalFinalTopK,
        finalTopK: this.settings.retrievalFinalTopK,
        minimumScore: useEnhancements ? this.settings.similarityThreshold : -1,
        expandRelevantSources: useEnhancements,
      },
      (queryVector, topK) => this.indexController.searchVector(queryVector, topK),
    );
  }

  async answerQuestion(
    question: string,
    history: readonly ChatTurn[],
    useRag: boolean,
    useRetrievalEnhancements: boolean,
    taskMemory: TaskMemory,
  ): Promise<RagAnswer> {
    const apiKey = this.app.secretStorage.getSecret(this.settings.llmApiKeySecretId)?.trim();
    if (!apiKey) throw new Error('Добавьте API-ключ DeepSeek в настройках плагина.');
    const snapshot = useRag ? this.validatedSnapshot() : null;
    return this.ragService.answer(
      question,
      snapshot,
      this.deepSeekConfig(apiKey),
      {
        useRag,
        useRetrievalEnhancements,
        candidateTopK: this.settings.retrievalCandidateTopK,
        finalTopK: this.settings.retrievalFinalTopK,
        similarityThreshold: this.settings.similarityThreshold,
      },
      history,
      snapshot
        ? (queryVector, topK) => this.indexController.searchVector(queryVector, topK)
        : undefined,
      taskMemory,
    );
  }

  async loadChatState(): Promise<ChatState> {
    return this.chatStateRepository.load();
  }

  async saveChatState(state: ChatState): Promise<void> {
    await this.chatStateRepository.save(state);
  }

  async clearChatState(): Promise<void> {
    await this.chatStateRepository.clear();
  }

  usesRag(): boolean {
    return this.settings.useRag;
  }

  usesRetrievalEnhancements(): boolean {
    return this.settings.useRetrievalEnhancements;
  }

  refreshChatViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)) {
      if (leaf.view instanceof ChatView) leaf.view.refreshMode();
    }
  }

  hasDeepSeekApiKey(): boolean {
    return Boolean(this.app.secretStorage.getSecret(this.settings.llmApiKeySecretId)?.trim());
  }

  async saveDeepSeekApiKey(value: string): Promise<void> {
    const secret = value.trim();
    if (!secret) throw new Error('Введите API-ключ DeepSeek.');
    this.app.secretStorage.setSecret(this.settings.llmApiKeySecretId, secret);
    await this.saveSettings();
  }

  async clearDeepSeekApiKey(): Promise<void> {
    this.app.secretStorage.setSecret(this.settings.llmApiKeySecretId, '');
    await this.saveSettings();
  }

  async testDeepSeekConnection(): Promise<void> {
    const apiKey = this.app.secretStorage.getSecret(this.settings.llmApiKeySecretId)?.trim();
    if (!apiKey) throw new Error('Добавьте API-ключ DeepSeek перед проверкой.');
    await this.llmClient.testConnection(this.deepSeekConfig(apiKey));
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

  private deepSeekConfig(apiKey: string) {
    return {
      provider: 'deepseek' as const,
      baseUrl: DEEPSEEK_API_BASE_URL,
      model: this.settings.llmModel,
      apiKey,
    };
  }

  private validatedSnapshot() {
    const snapshot = this.indexController.getSnapshot();
    return validateIndexSnapshot(snapshot, this.settings, this.currentScopeSignature());
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
      this.refreshChatViews();
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
