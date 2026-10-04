import { ItemView, Notice, WorkspaceLeaf } from 'obsidian';
import { citationParts, sourceLinkText } from '../retrieval/citations';
import type {
  ChatTurn,
  GroundedCitation,
  RagAnswer,
  RetrievalDiagnostics,
  SearchResult,
  TaskMemory,
} from '../types';
import { isTaskMemoryEmpty } from '../rag/task-memory';
import { historyForMode } from './chat-history';
import {
  chatMode,
  emptyChatState,
  type ChatState,
} from './chat-state';

export const CHAT_VIEW_TYPE = 'ai-advent-rag-chat';

export interface ChatPluginApi {
  answerQuestion(
    question: string,
    history: readonly ChatTurn[],
    useRag: boolean,
    useRetrievalEnhancements: boolean,
    taskMemory: TaskMemory,
  ): Promise<RagAnswer>;
  openSource(source: SearchResult): Promise<void>;
  indexSummary(): string;
  usesRag(): boolean;
  usesRetrievalEnhancements(): boolean;
  loadChatState(): Promise<ChatState>;
  saveChatState(state: ChatState): Promise<void>;
  clearChatState(): Promise<void>;
}

export class ChatView extends ItemView {
  private state = emptyChatState();
  private inFlight = false;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly pluginApi: ChatPluginApi,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return CHAT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Чат с DeepSeek';
  }

  getIcon(): string {
    return 'message-circle';
  }

  async onOpen(): Promise<void> {
    try {
      this.state = await this.pluginApi.loadChatState();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
      this.state = emptyChatState();
    }
    this.render();
  }

  async onClose(): Promise<void> {
    await this.persistState();
  }

  refreshMode(): void {
    if (!this.inFlight) this.render();
  }

  private render(): void {
    const container = this.contentEl;
    container.empty();
    container.addClass('ai-advent-rag-view');

    const header = container.createDiv({ cls: 'ai-advent-rag-chat-header' });
    header.createEl('h3', { text: 'Чат с DeepSeek' });
    const clearButton = header.createEl('button', { text: 'Очистить чат' });
    clearButton.disabled = this.inFlight;
    clearButton.addEventListener('click', () => {
      if (this.inFlight) return;
      void (async () => {
        this.state = emptyChatState();
        try {
          await this.pluginApi.clearChatState();
        } catch (error) {
          new Notice(error instanceof Error ? error.message : String(error));
        }
        this.render();
      })();
    });

    const useRag = this.pluginApi.usesRag();
    const useRetrievalEnhancements = useRag && this.pluginApi.usesRetrievalEnhancements();
    const activeMode = chatMode(useRag, useRetrievalEnhancements);
    const taskMemory = this.state.taskMemories[activeMode];
    container.createDiv({
      cls: `ai-advent-rag-mode ${useRag ? 'is-rag' : 'is-direct'}`,
      text: !useRag
        ? 'Режим: без RAG'
        : useRetrievalEnhancements
          ? 'Режим: RAG с фильтрацией и переформулированием'
          : 'Режим: базовый RAG без фильтрации и переформулирования',
    });
    container.createDiv({
      cls: 'ai-advent-rag-privacy-note',
      text: !useRag
        ? 'В DeepSeek отправляются только вопрос и недавняя история текущего чата. Заметки и локальный индекс не используются.'
        : useRetrievalEnhancements
          ? 'DeepSeek обновляет память задачи и переформулирует вопрос для поиска. Затем локальный Qwen ищет кандидатов, similarity-фильтр отбрасывает слабые совпадения, а в DeepSeek отправляются вопрос, история, память, метаданные и выбранные фрагменты. Ответ и цитаты проверяются локально.'
          : 'DeepSeek обновляет память задачи. По исходному вопросу выполняется локальный поиск без порога релевантности, после чего в DeepSeek отправляются вопрос, история, память, метаданные и выбранные фрагменты. Ответ и цитаты проверяются локально.',
    });
    container.createDiv({
      cls: 'ai-advent-rag-history-note',
      text: 'История и память задачи сохраняются только локально в папке плагина. Хранится не более 80 последних сообщений.',
    });
    if (useRag) {
      container.createDiv({ cls: 'ai-advent-rag-index-status', text: this.pluginApi.indexSummary() });
    }
    const taskMemoryContainer = container.createDiv({ cls: 'ai-advent-rag-task-memory-container' });
    this.renderTaskMemory(taskMemoryContainer, taskMemory, useRag);

    const messages = container.createDiv({
      cls: 'ai-advent-rag-messages',
      attr: { role: 'list', 'aria-busy': this.inFlight ? 'true' : 'false' },
    });
    this.renderEntries(messages);

    const composer = container.createDiv({ cls: 'ai-advent-rag-composer' });
    composer.createEl('label', {
      text: 'Сообщение',
      attr: { for: 'ai-advent-rag-question' },
    });
    const query = composer.createEl('textarea', {
      cls: 'ai-advent-rag-question',
      attr: {
        id: 'ai-advent-rag-question',
        placeholder: 'Задайте вопрос по заметкам…',
        rows: '4',
        maxlength: '4000',
      },
    });
    const controls = composer.createDiv({ cls: 'ai-advent-rag-composer-controls' });
    const status = controls.createDiv({
      cls: 'ai-advent-rag-search-status',
      attr: { role: 'status', 'aria-live': 'polite' },
    });
    const sendButton = controls.createEl('button', {
      cls: 'mod-cta ai-advent-rag-ask',
      text: 'Отправить',
    });
    const submit = async (): Promise<void> => {
      const value = query.value.trim();
      if (!value || this.inFlight) return;
      const history = historyForMode(this.state.entries, useRag, useRetrievalEnhancements);
      const currentTaskMemory = this.state.taskMemories[activeMode];
      this.state.entries.push({
        role: 'user',
        content: value,
        usedRag: useRag,
        usedRetrievalEnhancements: useRetrievalEnhancements,
      });
      this.renderEntries(messages);
      await this.persistState();
      query.value = '';
      this.inFlight = true;
      messages.setAttribute('aria-busy', 'true');
      clearButton.disabled = true;
      sendButton.disabled = true;
      sendButton.setText('Отправка…');
      status.setText(
        !useRag
          ? 'Жду ответ DeepSeek…'
          : useRetrievalEnhancements
            ? 'Обновляю память задачи, переформулирую запрос, фильтрую фрагменты и жду ответ DeepSeek…'
            : 'Обновляю память задачи, ищу фрагменты без фильтрации и жду ответ DeepSeek…',
      );

      try {
        const answer = await this.pluginApi.answerQuestion(
          value,
          history,
          useRag,
          useRetrievalEnhancements,
          currentTaskMemory,
        );
        this.state.taskMemories[activeMode] = answer.taskMemory;
        this.state.entries.push({
          role: 'assistant',
          content: answer.text,
          sources: answer.sources,
          citations: answer.citations,
          groundingStatus: answer.groundingStatus,
          usedRag: answer.usedRag,
          usedRetrievalEnhancements: answer.usedRetrievalEnhancements,
          modelCalled: answer.modelCalled,
          retrieval: answer.retrieval,
        });
        await this.persistState();
        taskMemoryContainer.empty();
        this.renderTaskMemory(taskMemoryContainer, answer.taskMemory, useRag);
        this.renderEntries(messages);
        status.setText(
          answer.modelCalled
            ? answer.usedRag
              ? answer.groundingStatus === 'grounded'
                ? `Ответ подтверждён: ${answer.citations.length} источников с проверенными цитатами.`
                : 'Ответ отклонён из-за слабого или неподтверждённого контекста. Попросите уточнить вопрос.'
              : 'Ответ без RAG получен.'
            : answer.usedRetrievalEnhancements
              ? 'После фильтрации релевантных фрагментов не осталось; DeepSeek выполнил rewriting, но ответ не генерировался.'
              : 'Релевантные фрагменты не найдены; запрос в DeepSeek не выполнялся.',
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const pending = this.state.entries.at(-1);
        if (pending?.role === 'user' && pending.content === value) this.state.entries.pop();
        await this.persistState();
        this.renderEntries(messages);
        status.setText('Не удалось получить ответ.');
        new Notice(message);
        const errorEntry = messages.createDiv({ cls: 'ai-advent-rag-error', text: message });
        errorEntry.setAttribute('role', 'alert');
      } finally {
        this.inFlight = false;
        messages.setAttribute('aria-busy', 'false');
        clearButton.disabled = false;
        sendButton.disabled = false;
        sendButton.setText('Отправить');
        if (
          this.pluginApi.usesRag() !== useRag ||
          (useRag && this.pluginApi.usesRetrievalEnhancements() !== useRetrievalEnhancements)
        ) this.render();
        else query.focus();
      }
    };

    sendButton.addEventListener('click', () => void submit());
    query.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void submit();
    });
  }

  private renderEntries(container: HTMLElement): void {
    container.empty();
    if (this.state.entries.length === 0) {
      container.createDiv({
        cls: 'ai-advent-rag-empty',
        text: 'Сообщений пока нет. Режим RAG можно изменить в настройках плагина.',
      });
      return;
    }

    for (const entry of this.state.entries) {
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
                ? 'DeepSeek · RAG с фильтрацией'
                : 'DeepSeek · базовый RAG'
              : 'DeepSeek · без RAG',
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
    if (diagnostics.taskMemoryUpdateFailed) {
      details.createDiv({ text: 'Не удалось обновить память задачи — использована предыдущая версия.' });
    }
  }

  private renderTaskMemory(
    container: HTMLElement,
    memory: TaskMemory,
    useRag: boolean,
  ): void {
    const details = container.createEl('details', {
      cls: 'ai-advent-rag-task-memory',
      attr: { open: '' },
    });
    details.createEl('summary', { text: 'Память задачи' });
    if (!useRag) {
      details.createDiv({ text: 'Память задачи обновляется только в режиме RAG.' });
      return;
    }
    if (isTaskMemoryEmpty(memory)) {
      details.createDiv({ text: 'Пока пуста. Цель и ограничения появятся после первого сообщения.' });
      return;
    }
    if (memory.goal) {
      const goal = details.createDiv({ cls: 'ai-advent-rag-memory-goal' });
      goal.createEl('strong', { text: 'Цель: ' });
      goal.createSpan({ text: memory.goal });
    }
    this.renderMemoryList(details, 'Уточнено', memory.clarifiedFacts);
    this.renderMemoryList(details, 'Ограничения', memory.constraints);
    this.renderMemoryList(
      details,
      'Термины',
      memory.terms.map((term) => `${term.term} — ${term.meaning}`),
    );
  }

  private renderMemoryList(container: HTMLElement, title: string, items: readonly string[]): void {
    if (items.length === 0) return;
    container.createDiv({ cls: 'ai-advent-rag-memory-label', text: title });
    const list = container.createEl('ul');
    for (const item of items) list.createEl('li', { text: item });
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
    usedRetrievalEnhancements = false,
  ): void {
    const section = container.createDiv({ cls: 'ai-advent-rag-sent-sources' });
    section.createDiv({
      cls: 'ai-advent-rag-sent-sources-title',
      text: 'Фрагменты, отправленные в DeepSeek',
    });
    if (sources.length === 0) {
      section.createDiv({
        text: usedRetrievalEnhancements
          ? 'После фильтрации релевантных фрагментов не осталось; генерация ответа не выполнялась.'
          : 'Релевантные фрагменты не найдены; запрос в DeepSeek не выполнялся.',
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
        text: ` · similarity ${source.score.toFixed(3)} · строки ${source.chunk.metadata.line_start}–${source.chunk.metadata.line_end}${source.contextTruncated ? ' · текст обрезан до лимита' : ''}`,
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

  private async persistState(): Promise<void> {
    try {
      await this.pluginApi.saveChatState(this.state);
    } catch (error) {
      new Notice(`Не удалось сохранить историю чата: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
