import { ItemView, Notice, WorkspaceLeaf } from 'obsidian';
import { citationParts, sourceLinkText } from '../retrieval/citations';
import type { GroundedCitation, RetrievalDiagnostics, SearchResult } from '../types';
import { MAX_DIALOGS } from './chat-state';
import type { ChatController } from './chat-controller';

export const CHAT_VIEW_TYPE = 'ai-advent-rag-chat';
export interface ChatPluginApi {
  chatController: ChatController;
  openSource(source: SearchResult): Promise<void>;
}

export class ChatView extends ItemView {
  private unsubscribe?: () => void;
  private queryEl?: HTMLTextAreaElement;
  private statusEl?: HTMLElement;
  private queueEl?: HTMLElement;
  private activityEl?: HTMLElement;
  private liveBody?: HTMLElement;
  private messagesEl?: HTMLElement;
  private contextRemoveButton?: HTMLButtonElement;
  private tabs = new Map<string, HTMLButtonElement>();

  constructor(leaf: WorkspaceLeaf, private readonly pluginApi: ChatPluginApi) { super(leaf); }
  getViewType(): string { return CHAT_VIEW_TYPE; }
  getDisplayText(): string { return 'Диалоги с Qwen'; }
  getIcon(): string { return 'message-circle'; }

  async onOpen(): Promise<void> {
    try {
      await this.pluginApi.chatController.initialize();
      this.unsubscribe = this.pluginApi.chatController.subscribe((kind) => {
        if (kind === 'change') this.render();
        else this.refreshProgress();
      });
      this.render();
    } catch (error) {
      this.contentEl.empty();
      this.contentEl.createDiv({ cls: 'ai-advent-rag-error', text: error instanceof Error ? error.message : String(error) });
    }
  }
  async onClose(): Promise<void> { this.unsubscribe?.(); }
  refreshMode(): void { if (this.unsubscribe) this.render(); }

  private action(run: () => void): void {
    try { run(); } catch (error) { new Notice(error instanceof Error ? error.message : String(error)); }
  }
  private tabLabel(id: string, title: string): string {
    const runtime = this.pluginApi.chatController.runtime(id);
    return runtime.phase === 'queued' ? `${title} · очередь ${runtime.position}`
      : runtime.phase === 'running' ? `${title} · ●` : runtime.error ? `${title} · ошибка` : title;
  }

  private render(): void {
    const controller = this.pluginApi.chatController;
    const dialog = controller.activeDialog;
    const restoreFocus = this.queryEl === document.activeElement;
    const selection = this.queryEl?.selectionStart ?? 0;
    const container = this.contentEl;
    container.empty();
    container.addClass('ai-advent-rag-view');
    this.tabs.clear();
    this.activityEl = undefined;
    this.liveBody = undefined;
    this.contextRemoveButton = undefined;
    const header = container.createDiv({ cls: 'ai-advent-rag-chat-header' });
    header.createEl('h3', { text: `Диалоги с Qwen · ${controller.state.dialogs.length}/${MAX_DIALOGS}` });
    const add = header.createEl('button', { text: '+ новый диалог' });
    add.disabled = controller.state.dialogs.length >= MAX_DIALOGS;
    add.addEventListener('click', () => this.action(() => { controller.createDialog(); }));
    const tabs = container.createDiv({ cls: 'ai-advent-rag-dialog-tabs', attr: { role: 'group', 'aria-label': 'Диалоги' } });
    for (const item of controller.state.dialogs) {
      const tab = tabs.createEl('button', {
        text: this.tabLabel(item.id, item.title),
        cls: item.id === dialog?.id ? 'is-active' : '',
        attr: { 'aria-pressed': item.id === dialog?.id ? 'true' : 'false', title: item.title },
      });
      tab.addEventListener('click', () => this.action(() => controller.selectDialog(item.id)));
      this.tabs.set(item.id, tab);
    }
    this.queueEl = container.createDiv({ cls: 'ai-advent-rag-search-status', text: controller.queueSummary });
    if (!dialog) return;
    const runtime = controller.runtime(dialog.id);
    const busy = runtime.phase !== 'idle';
    const actions = container.createDiv({ cls: 'ai-advent-rag-dialog-actions' });
    const clear = actions.createEl('button', { text: 'Очистить диалог' });
    clear.disabled = busy;
    clear.addEventListener('click', () => this.action(() => controller.clearDialog(dialog.id)));
    const remove = actions.createEl('button', { text: 'Удалить диалог' });
    remove.disabled = busy;
    remove.addEventListener('click', () => this.action(() => controller.deleteDialog(dialog.id)));
    if (dialog.contextPath) {
      const context = container.createDiv({ cls: 'ai-advent-rag-note-context' });
      context.createSpan({ text: `Контекст: ${dialog.contextPath}` });
      this.contextRemoveButton = context.createEl('button', {
        text: '×', attr: { 'aria-label': `Убрать ${dialog.contextPath} из контекста`, title: 'Убрать закреплённую заметку' },
      });
      this.contextRemoveButton.disabled = runtime.phase === 'running';
      this.contextRemoveButton.addEventListener('click', () => this.action(() => controller.removeContext(dialog.id)));
    } else container.createDiv({ cls: 'ai-advent-rag-search-status', text: 'Без закреплённой заметки · поиск по хранилищу включён' });
    const messages = container.createDiv({ cls: 'ai-advent-rag-messages', attr: { role: 'list', 'aria-busy': busy ? 'true' : 'false' } });
    this.messagesEl = messages;
    this.renderEntries(messages);
    if (busy) {
      const pending = messages.createDiv({ cls: 'ai-advent-rag-message is-assistant is-pending', attr: { role: 'listitem' } });
      this.activityEl = pending.createDiv({ cls: 'ai-advent-rag-message-label', text: runtime.status, attr: { role: 'status', 'aria-live': 'polite' } });
      this.liveBody = pending.createDiv({ cls: 'ai-advent-rag-message-body', text: runtime.text });
    }
    if (runtime.error) messages.createDiv({ cls: 'ai-advent-rag-error', text: runtime.error, attr: { role: 'alert' } });
    const composer = container.createDiv({ cls: 'ai-advent-rag-composer' });
    const inputId = `ai-advent-rag-question-${dialog.id}`;
    composer.createEl('label', { text: 'Сообщение', attr: { for: inputId } });
    const query = composer.createEl('textarea', { cls: 'ai-advent-rag-question',
      attr: { id: inputId, placeholder: 'Задайте вопрос по заметкам…', rows: '4', maxlength: '4000' } });
    this.queryEl = query;
    query.value = controller.drafts.get(dialog.id) ?? '';
    query.disabled = busy;
    query.addEventListener('input', () => { controller.drafts.set(dialog.id, query.value); });
    const controls = composer.createDiv({ cls: 'ai-advent-rag-composer-controls' });
    this.statusEl = controls.createDiv({ cls: 'ai-advent-rag-search-status', text: runtime.status,
      attr: { role: 'status', 'aria-live': 'polite' } });
    const send = controls.createEl('button', { cls: 'mod-cta', text: busy ? 'Запрос отправлен' : 'Отправить' });
    send.disabled = busy;
    const submit = (): void => {
      const value = query.value.trim();
      if (!value) return;
      void controller.send(dialog.id, value).catch((error: unknown) => {
        new Notice(error instanceof Error ? error.message : String(error));
      });
    };
    send.addEventListener('click', submit);
    query.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); submit(); }
    });
    messages.scrollTop = messages.scrollHeight;
    if (restoreFocus && !busy) { query.focus(); query.setSelectionRange(selection, selection); }
  }

  private refreshProgress(): void {
    const controller = this.pluginApi.chatController;
    this.queueEl?.setText(controller.queueSummary);
    for (const dialog of controller.state.dialogs) this.tabs.get(dialog.id)?.setText(this.tabLabel(dialog.id, dialog.title));
    const dialog = controller.activeDialog;
    if (!dialog) return;
    const runtime = controller.runtime(dialog.id);
    this.contextRemoveButton && (this.contextRemoveButton.disabled = runtime.phase === 'running');
    this.activityEl?.setText(runtime.status);
    this.statusEl?.setText(runtime.status);
    this.liveBody?.setText(runtime.text);
    if (this.messagesEl && runtime.phase === 'running') this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private renderEntries(container: HTMLElement): void {
    container.empty();
    if ((this.pluginApi.chatController.activeDialog?.entries.length ?? 0) === 0) {
      container.createDiv({
        cls: 'ai-advent-rag-empty',
        text: 'Сообщений пока нет. Задайте вопрос — Qwen найдёт подходящие фрагменты заметок.',
      });
      return;
    }

    for (const entry of this.pluginApi.chatController.activeDialog?.entries ?? []) {
      const message = container.createDiv({
        cls: `ai-advent-rag-message is-${entry.role}`,
        attr: { role: 'listitem' },
      });
      message.createDiv({
        cls: 'ai-advent-rag-message-label',
        text: entry.role === 'user'
          ? 'Вы'
          : entry.modelCalled === false
            ? entry.usedRetrievalEnhancements
              ? 'RAG · локальный отказ после переформулирования'
              : 'RAG · локальный ответ'
            : entry.usedRag
              ? entry.usedRetrievalEnhancements
                ? 'Qwen (локально) · RAG с фильтрацией'
                : 'Qwen (локально) · базовый RAG'
              : 'Qwen (локально) · без RAG',
      });
      const body = message.createDiv({ cls: 'ai-advent-rag-message-body' });
      if (entry.role === 'assistant') {
        this.renderAnswer(body, entry.content, entry.sources ?? []);
        if (entry.usedRag) {
          if (entry.groundingStatus === 'grounded') {
            this.renderGroundedCitations(message, entry.citations ?? [], entry.sources ?? []);
          }
          if (entry.retrieval) this.renderRetrievalDiagnostics(message, entry.retrieval);
          this.renderSentSources(message, entry.sources ?? [], entry.usedRetrievalEnhancements);
        }
      } else {
        body.setText(entry.content);
      }
    }
    container.scrollTop = container.scrollHeight;
  }

  private renderAnswer(container: HTMLElement, answer: string, sources: readonly SearchResult[]): void {
    for (const part of citationParts(answer, sources)) {
      if (!part.source) {
        container.createSpan({ text: part.text });
        continue;
      }
      const link = container.createEl('a', {
        href: '#',
        text: part.text,
        attr: { 'aria-label': `Открыть ${sourceLinkText(part.source)}` },
      });
      link.addEventListener('click', (event) => {
        event.preventDefault();
        void this.openSource(part.source!);
      });
    }
  }

  private renderRetrievalDiagnostics(
    container: HTMLElement,
    diagnostics: RetrievalDiagnostics,
  ): void {
    const details = container.createDiv({ cls: 'ai-advent-rag-retrieval-details' });
    const threshold = diagnostics.similarityThreshold === null
      ? 'без порога'
      : `порог ≥ ${diagnostics.similarityThreshold.toFixed(2)}`;
    details.createDiv({
      text: `Поиск: ${diagnostics.candidateCount} кандидатов → ${diagnostics.resultCount} фрагментов; ${threshold}.`,
    });
    if (diagnostics.queryRewritten) {
      details.createDiv({ text: `Поисковый запрос: ${diagnostics.searchQuery}` });
    } else if (diagnostics.rewriteFailed) {
      details.createDiv({ text: 'Переформулирование не удалось — использован исходный вопрос.' });
    }
    if (diagnostics.groundingRepairAttempted) {
      details.createDiv({
        text: diagnostics.groundingValidationFailed
          ? 'Ответ модели дважды не прошёл локальную проверку цитат и был заменён безопасным отказом.'
          : 'Первый ответ модели не прошёл проверку цитат; исправленная версия подтверждена локально.',
      });
    }
  }

  private renderGroundedCitations(
    container: HTMLElement,
    citations: readonly GroundedCitation[],
    sources: readonly SearchResult[],
  ): void {
    const section = container.createDiv({ cls: 'ai-advent-rag-grounded-citations' });
    section.createDiv({
      cls: 'ai-advent-rag-grounded-citations-title',
      text: 'Источники и проверенные цитаты',
    });
    const list = section.createEl('ol');
    for (const citation of citations) {
      const item = list.createEl('li');
      const trustedSource = sources.find((source) => source.sourceId === citation.sourceId);
      if (trustedSource) {
        const link = item.createEl('a', {
          href: '#',
          text: `${citation.sourceId}: ${sourceLinkText(trustedSource)}`,
        });
        link.addEventListener('click', (event) => {
          event.preventDefault();
          void this.openSource(trustedSource);
        });
      } else {
        item.createSpan({ text: `${citation.sourceId}: ${citation.source}` });
      }
      item.createDiv({
        cls: 'ai-advent-rag-citation-metadata',
        text: `Раздел: ${citation.section ?? 'без раздела'} · chunk_id: ${citation.chunkId}`,
      });
      item.createEl('blockquote', { text: citation.quote });
    }
  }

  private renderSentSources(
    container: HTMLElement,
    sources: readonly SearchResult[],
    _usedRetrievalEnhancements = false,
  ): void {
    const section = container.createDiv({ cls: 'ai-advent-rag-sent-sources' });
    section.createDiv({
      cls: 'ai-advent-rag-sent-sources-title',
      text: 'Фрагменты, отправленные в Qwen (локально)',
    });
    if (sources.length === 0) {
      section.createDiv({
        text: 'Фрагменты не найдены. Модель получила вопрос и историю диалога.',
      });
      return;
    }
    const list = section.createEl('ul');
    for (const source of sources) {
      const item = list.createEl('li');
      const link = item.createEl('a', {
        href: '#',
        text: `${source.sourceId}: ${sourceLinkText(source)}`,
      });
      link.addEventListener('click', (event) => {
        event.preventDefault();
        void this.openSource(source);
      });
      item.createSpan({
        cls: 'ai-advent-rag-score',
        text: source.isActiveNote
          ? ` · закреплённая заметка${source.contextTruncated ? ' · первые 12 000 символов' : ''}`
          : ` · similarity ${source.score.toFixed(3)} · строки ${source.chunk.metadata.line_start}–${source.chunk.metadata.line_end}${source.contextTruncated ? ' · текст обрезан до лимита' : ''}`,
      });
    }
  }

  private async openSource(source: SearchResult): Promise<void> {
    try {
      await this.pluginApi.openSource(source);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    }
  }

}
