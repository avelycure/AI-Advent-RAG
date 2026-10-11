import { RetrievalService } from '../retrieval/retrieval-service';
import { MAX_QUESTION_CHARACTERS, buildChatRagMessages, selectSourcesForContext } from './prompt';
import { rewriteSearchQuery } from './query-rewriter';
import { MAX_ACTIVE_NOTE_CHARACTERS } from '../types';
import type { ActiveNoteContext, ChatProgress, ChatTurn, EmbeddingClient, LlmClient, LlmConfig, RagAnswer, RagPipelineOptions,
  RetrievalDiagnostics, VectorIndexSnapshot, VectorSearchHit } from '../types';

export class RagService {
  private readonly retrieval: RetrievalService;

  constructor(embeddings: EmbeddingClient, private readonly llm: LlmClient) {
    this.retrieval = new RetrievalService(embeddings);
  }

  async answer(
    question: string, index: VectorIndexSnapshot | null, llmConfig: LlmConfig, options: RagPipelineOptions,
    history: readonly ChatTurn[] = [],
    backendSearch?: (queryVector: number[], topK: number) => Promise<VectorSearchHit[] | null>,
    onProgress?: (progress: ChatProgress) => void,
    activeNote?: ActiveNoteContext,
  ): Promise<RagAnswer> {
    llmConfig.signal?.throwIfAborted();
    const normalizedQuestion = question.trim();
    if (!normalizedQuestion) throw new Error('Введите вопрос.');
    if (normalizedQuestion.length > MAX_QUESTION_CHARACTERS) throw new Error('Вопрос не должен превышать 4 000 символов.');
    if (!index) throw new Error('Сначала перестройте локальный индекс в настройках плагина.');
    onProgress?.({ kind: 'stage', text: 'Переформулирую вопрос для поиска…' });
    const rewrite = await rewriteSearchQuery(normalizedQuestion, history, this.llm, llmConfig, undefined, activeNote);
    llmConfig.signal?.throwIfAborted();
    onProgress?.({ kind: 'stage', text: 'Ищу фрагменты заметок…' });
    const retrievalOptions = {
      candidateTopK: options.candidateTopK,
      finalTopK: options.finalTopK,
      minimumScore: options.similarityThreshold,
      expandRelevantSources: true,
    };
    const retrieval = index.chunks.length > 0
      ? await this.retrieval.search(rewrite.query, index, retrievalOptions, backendSearch, llmConfig.signal)
      : { results: [], candidateCount: 0 };
    llmConfig.signal?.throwIfAborted();
    const pinnedText = activeNote?.content.slice(0, MAX_ACTIVE_NOTE_CHARACTERS);
    const pinned: RagAnswer['sources'] = activeNote && pinnedText ? [{
      sourceId: '', score: 1, isActiveNote: true,
      contextTruncated: pinnedText.length < activeNote.content.length,
      chunk: {
        ordinal: 0, text: pinnedText, contentHash: '', vector: [],
        metadata: { source: activeNote.path, title: activeNote.title, section: null,
          chunk_id: `active-note:${activeNote.path}`, line_start: 1,
          line_end: pinnedText.split('\n').length, file_mtime: activeNote.mtime },
      },
    }] : [];
    const selected = [...pinned, ...retrieval.results.filter((source) => !pinned.length || source.chunk.metadata.source !== activeNote?.path)]
      .slice(0, options.finalTopK);
    const sources = selectSourcesForContext(selected);
    const diagnostics: RetrievalDiagnostics = {
      originalQuery: normalizedQuestion, searchQuery: rewrite.query, queryRewritten: rewrite.rewritten,
      rewriteFailed: rewrite.failed, candidateCount: retrieval.candidateCount, resultCount: sources.length,
      candidateTopK: retrievalOptions.candidateTopK, finalTopK: retrievalOptions.finalTopK,
      similarityThreshold: options.similarityThreshold,
    };
    onProgress?.({ kind: 'stage', text: 'Qwen готовит ответ…' });
    const text = await this.llm.generate(
      buildChatRagMessages(normalizedQuestion, sources, history, activeNote),
      llmConfig,
      onProgress ? (delta) => onProgress({ kind: 'text', text: delta }) : undefined,
    );
    return {
      text, sources, citations: [], groundingStatus: 'not-applicable',
      usedRag: true, usedRetrievalEnhancements: true,
      modelCalled: true, retrieval: diagnostics,
    };
  }
}
