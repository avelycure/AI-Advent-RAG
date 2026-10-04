import { ItemView, Notice, WorkspaceLeaf } from 'obsidian';
import type { RetrievalResponse, SearchResult } from '../types';

export const CHAT_VIEW_TYPE = 'ai-advent-rag-chat';

export interface ChatPluginApi {
  search(query: string): Promise<RetrievalResponse>;
  openSource(source: SearchResult): Promise<void>;
  indexSummary(): string;
}

export class ChatView extends ItemView {
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
    return 'Semantic search';
  }

  getIcon(): string {
    return 'search';
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  private render(): void {
    const container = this.contentEl;
    container.empty();
    container.addClass('ai-advent-rag-view');
    container.createEl('h3', { text: 'Search indexed notes' });
    container.createDiv({
      cls: 'ai-advent-rag-privacy-note',
      text: 'Retrieval-only mode: the query is embedded by local Ollama. No note text is sent to an LLM.',
    });
    container.createDiv({ cls: 'ai-advent-rag-index-status', text: this.pluginApi.indexSummary() });

    container.createEl('label', {
      text: 'Search query',
      attr: { for: 'ai-advent-rag-question' },
    });
    const query = container.createEl('textarea', {
      cls: 'ai-advent-rag-question',
      attr: {
        id: 'ai-advent-rag-question',
        placeholder: 'Describe what you want to find in the indexed notes…',
        rows: '4',
      },
    });
    const searchButton = container.createEl('button', {
      cls: 'mod-cta ai-advent-rag-ask',
      text: 'Search',
    });
    const status = container.createDiv({
      cls: 'ai-advent-rag-search-status',
      attr: { role: 'status', 'aria-live': 'polite' },
    });
    const result = container.createDiv({
      cls: 'ai-advent-rag-result',
    });
    let inFlight = false;

    const submit = async (): Promise<void> => {
      const value = query.value.trim();
      if (!value || inFlight) return;
      inFlight = true;
      searchButton.disabled = true;
      searchButton.setText('Searching…');
      result.empty();
      status.setText('Embedding the query locally and searching the index…');
      try {
        const response = await this.pluginApi.search(value);
        this.renderResults(result, response);
        status.setText(`${response.results.length} fragments found for “${response.query}”.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.empty();
        result.createDiv({ cls: 'ai-advent-rag-error', text: message });
        status.setText('Search failed.');
        new Notice(message);
      } finally {
        inFlight = false;
        searchButton.disabled = false;
        searchButton.setText('Search');
      }
    };

    searchButton.addEventListener('click', () => void submit());
    query.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void submit();
    });
  }

  private renderResults(container: HTMLElement, response: RetrievalResponse): void {
    container.empty();
    const strategy = response.strategy === 'fixed-size' ? 'fixed size' : 'Markdown structure';
    container.createDiv({
      cls: 'ai-advent-rag-result-summary',
      text: `${response.results.length} fragments found for “${response.query}” · chunking: ${strategy}.`,
    });
    if (response.results.length === 0) {
      container.createDiv({
        cls: 'ai-advent-rag-empty',
        text: 'No sufficiently similar fragments were found in the local index.',
      });
      return;
    }

    const list = container.createEl('ol', { cls: 'ai-advent-rag-results' });
    for (const source of response.results) {
      const item = list.createEl('li', { cls: 'ai-advent-rag-result-card' });
      const header = item.createDiv({ cls: 'ai-advent-rag-result-header' });
      const link = header.createEl('a', {
        href: '#',
        text: source.chunk.metadata.title,
      });
      link.addEventListener('click', (event) => {
        event.preventDefault();
        void this.openSource(source);
      });
      header.createSpan({
        cls: 'ai-advent-rag-score',
        text: `Similarity ${source.score.toFixed(3)}`,
      });

      const section = source.chunk.metadata.section
        ? ` · ${source.chunk.metadata.section}`
        : '';
      item.createDiv({
        cls: 'ai-advent-rag-result-location',
        text: `${source.chunk.metadata.source}${section} · lines ${source.chunk.metadata.line_start}–${source.chunk.metadata.line_end}`,
      });
      item.createDiv({
        cls: 'ai-advent-rag-result-metadata',
        text: `chunk_id: ${source.chunk.metadata.chunk_id}`,
      });
      item.createEl('pre', {
        cls: 'ai-advent-rag-fragment',
        text: source.chunk.text,
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
