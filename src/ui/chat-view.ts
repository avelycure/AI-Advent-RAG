import { ItemView, Notice, setIcon, WorkspaceLeaf } from 'obsidian';
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
  private activityEl?: HTMLElement;
  private pendingEl?: HTMLElement;
  private liveBody?: HTMLElement;
  private messagesEl?: HTMLElement;
  private contextRemoveButton?: HTMLButtonElement;
  private tabs = new Map<string, HTMLButtonElement>();
  private draggedDialogId?: string;

  constructor(leaf: WorkspaceLeaf, private readonly pluginApi: ChatPluginApi) { super(leaf); }
  getViewType(): string { return CHAT_VIEW_TYPE; }
  getDisplayText(): string { return 'Диалоги с Qwen'; }
  getIcon(): string { return 'sparkles'; }

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
  private iconButton(container: HTMLElement, icon: string, label: string): HTMLButtonElement {
    const button = container.createEl('button', {
      cls: 'ai-advent-rag-icon-button', attr: { 'aria-label': label, title: label },
    });
    setIcon(button, icon);
    return button;
  }

  private refreshTabs(): void {
    const controller = this.pluginApi.chatController;
    for (const dialog of controller.state.dialogs) {
      const tab = this.tabs.get(dialog.id);
      const busy = controller.runtime(dialog.id).phase !== 'idle';
      tab?.toggleClass('is-busy', busy);
      tab?.setAttribute('aria-label', `${dialog.title}${busy ? ' · запрос выполняется или ожидает выполнения' : ''}`);
    }
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
    this.pendingEl = undefined;
    this.liveBody = undefined;
    this.contextRemoveButton = undefined;
    if (!dialog) return;
    const runtime = controller.runtime(dialog.id);
    const busy = runtime.phase !== 'idle';
    if (dialog.contextPath) {
      const context = container.createDiv({ cls: 'ai-advent-rag-note-context' });
      context.createSpan({ text: dialog.contextPath, attr: { title: `Закреплённая заметка: ${dialog.contextPath}` } });
      this.contextRemoveButton = this.iconButton(context, 'x', 'Убрать закреплённую заметку');
      this.contextRemoveButton.disabled = runtime.phase === 'running';
      this.contextRemoveButton.addEventListener('click', () => this.action(() => controller.removeContext(dialog.id)));
    }
    const messages = container.createDiv({ cls: 'ai-advent-rag-messages', attr: { role: 'list', 'aria-busy': busy ? 'true' : 'false' } });
    this.messagesEl = messages;
    this.renderEntries(messages);
    if (busy) {
      const pending = messages.createDiv({ cls: 'ai-advent-rag-message is-assistant is-pending', attr: { role: 'listitem' } });
      this.pendingEl = pending;
      pending.hidden = runtime.phase === 'queued';
      this.activityEl = pending.createDiv({ cls: 'ai-advent-rag-message-label', text: runtime.status, attr: { role: 'status', 'aria-live': 'polite' } });
      this.liveBody = pending.createDiv({ cls: 'ai-advent-rag-message-body', text: runtime.text });
    }
    if (runtime.error) messages.createDiv({ cls: 'ai-advent-rag-error', text: runtime.error, attr: { role: 'alert' } });
    const navigation = container.createEl('nav', { cls: 'ai-advent-rag-dialog-menu', attr: { 'aria-label': 'Диалоги' } });
    const tabs = navigation.createDiv({ cls: 'ai-advent-rag-dialog-tabs' });
    controller.state.dialogs.forEach((item, index) => {
      const tab = this.iconButton(tabs, 'file-text', item.title);
      tab.addClass('ai-advent-rag-dialog-tab');
      tab.toggleClass('is-active', item.id === dialog.id);
      tab.setAttribute('aria-pressed', item.id === dialog.id ? 'true' : 'false');
      tab.createSpan({ cls: 'ai-advent-rag-dialog-number', text: String(index + 1), attr: { 'aria-hidden': 'true' } });
      tab.setAttribute('title', `${item.title} · перетащите, чтобы изменить порядок · клик двумя пальцами — удалить`);
      tab.draggable = true;
      tab.addEventListener('dragstart', (event) => {
        this.draggedDialogId = item.id;
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', item.id);
        }
        tab.addClass('is-dragging');
      });
      tab.addEventListener('dragover', (event) => {
        if (!this.draggedDialogId || this.draggedDialogId === item.id) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        const after = event.clientX > tab.getBoundingClientRect().left + tab.offsetWidth / 2;
        tab.toggleClass('is-drop-before', !after);
        tab.toggleClass('is-drop-after', after);
      });
      tab.addEventListener('dragleave', () => {
        tab.removeClass('is-drop-before', 'is-drop-after');
      });
      tab.addEventListener('drop', (event) => {
        const sourceId = this.draggedDialogId;
        if (!sourceId) return;
        event.preventDefault();
        const after = event.clientX > tab.getBoundingClientRect().left + tab.offsetWidth / 2;
        this.draggedDialogId = undefined;
        this.action(() => controller.moveDialog(sourceId, item.id, after));
        for (const button of this.tabs.values()) button.removeClass('is-dragging', 'is-drop-before', 'is-drop-after');
      });
      tab.addEventListener('dragend', () => {
        this.draggedDialogId = undefined;
        for (const button of this.tabs.values()) button.removeClass('is-dragging', 'is-drop-before', 'is-drop-after');
      });
      tab.addEventListener('click', () => this.action(() => controller.selectDialog(item.id)));
      tab.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.action(() => controller.deleteDialog(item.id));
      });
      this.tabs.set(item.id, tab);
    });
    const add = this.iconButton(tabs, 'plus', 'Новый диалог');
    add.disabled = controller.state.dialogs.length >= MAX_DIALOGS;
    add.addEventListener('click', () => this.action(() => { controller.createDialog(); }));
    const composer = container.createDiv({ cls: 'ai-advent-rag-composer' });
    const inputId = `ai-advent-rag-question-${dialog.id}`;
    const query = composer.createEl('textarea', { cls: 'ai-advent-rag-question',
      attr: { id: inputId, 'aria-label': 'Сообщение', placeholder: 'Сообщение… Enter — отправить, Shift+Enter — новая строка', rows: '2', maxlength: '4000' } });
    this.queryEl = query;
    query.value = controller.drafts.get(dialog.id) ?? '';
    query.disabled = busy;
    query.addEventListener('input', () => { controller.drafts.set(dialog.id, query.value); });
    const submit = (): void => {
      const value = query.value.trim();
      if (!value) return;
      void controller.send(dialog.id, value).catch((error: unknown) => {
        new Notice(error instanceof Error ? error.message : String(error));
      });
    };
    query.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        submit();
      }
    });
    this.refreshTabs();
    messages.scrollTop = messages.scrollHeight;
    if (restoreFocus && !busy) { query.focus(); query.setSelectionRange(selection, selection); }
  }

  private refreshProgress(): void {
    const controller = this.pluginApi.chatController;
    this.refreshTabs();
    const dialog = controller.activeDialog;
    if (!dialog) return;
    const runtime = controller.runtime(dialog.id);
    this.contextRemoveButton && (this.contextRemoveButton.disabled = runtime.phase === 'running');
    this.activityEl?.setText(runtime.status);
    if (this.pendingEl) this.pendingEl.hidden = runtime.phase === 'queued';
    this.liveBody?.setText(runtime.text);
    if (this.messagesEl && runtime.phase === 'running') this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private renderEntries(container: HTMLElement): void {
    container.empty();
    if ((this.pluginApi.chatController.activeDialog?.entries.length ?? 0) === 0) {
      const card = container.createDiv({
        cls: 'ai-advent-rag-empty',
        attr: { role: 'listitem' },
      });
      const icon = card.createDiv({ cls: 'ai-advent-rag-empty-icon', attr: { 'aria-hidden': 'true' } });
      setIcon(icon, 'message-square');
      const content = card.createDiv({ cls: 'ai-advent-rag-empty-content' });
      content.createEl('h4', { text: 'Сообщений пока нет' });
      content.createEl('p', { text: 'Задайте вопрос — Qwen найдёт подходящие фрагменты заметок.' });
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
        if (entry.usedRag && ((entry.sources?.length ?? 0) > 0 || entry.retrieval)) {
          const sources = message.createEl('details', { cls: 'ai-advent-rag-source-details' });
          sources.createEl('summary', { text: `Источники · ${entry.sources?.length ?? 0}` });
          if (entry.groundingStatus === 'grounded') {
            this.renderGroundedCitations(sources, entry.citations ?? [], entry.sources ?? []);
          }
          if (entry.retrieval) this.renderRetrievalDiagnostics(sources, entry.retrieval);
          this.renderSentSources(sources, entry.sources ?? [], entry.usedRetrievalEnhancements);
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
    if (!diagnostics.queryRewritten && diagnostics.rewriteFailed) {
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
          : ` · sim ${source.score.toFixed(3)} · строки ${source.chunk.metadata.line_start}–${source.chunk.metadata.line_end}${source.contextTruncated ? ' · текст обрезан до лимита' : ''}`,
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
