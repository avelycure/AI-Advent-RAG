import { RetrievalService } from '../retrieval/retrieval-service';
import {
  MAX_QUESTION_CHARACTERS,
  buildDirectMessages,
  buildGroundingRepairMessages,
  buildRagMessages,
  selectSourcesForContext,
} from './prompt';
import { GroundingValidationError, parseGroundedResponse } from './grounded-response';
import { EMPTY_TASK_MEMORY, cloneTaskMemory, updateTaskMemory } from './task-memory';
import { rewriteSearchQuery } from './query-rewriter';
import type {
  ChatTurn,
  EmbeddingClient,
  LlmClient,
  LlmConfig,
  RagAnswer,
  RagPipelineOptions,
  RetrievalDiagnostics,
  TaskMemory,
  VectorIndexSnapshot,
  VectorSearchHit,
} from '../types';

export class RagService {
  private readonly retrieval: RetrievalService;

  constructor(
    embeddings: EmbeddingClient,
    private readonly llm: LlmClient,
  ) {
    this.retrieval = new RetrievalService(embeddings);
  }

  async answer(
    question: string,
    index: VectorIndexSnapshot | null,
    llmConfig: LlmConfig,
    options: RagPipelineOptions,
    history: readonly ChatTurn[] = [],
    backendSearch?: (queryVector: number[], topK: number) => Promise<VectorSearchHit[] | null>,
    taskMemory: TaskMemory = EMPTY_TASK_MEMORY,
  ): Promise<RagAnswer> {
    const normalizedQuestion = question.trim();
    if (!normalizedQuestion) throw new Error('Введите вопрос.');
    if (normalizedQuestion.length > MAX_QUESTION_CHARACTERS) {
      throw new Error(`Вопрос не должен превышать ${MAX_QUESTION_CHARACTERS.toLocaleString('ru-RU')} символов.`);
    }

    if (!options.useRag) {
      const text = await this.llm.generate(
        buildDirectMessages(normalizedQuestion, history),
        llmConfig,
      );
      return {
        text,
        sources: [],
        citations: [],
        groundingStatus: 'not-applicable',
        taskMemory: cloneTaskMemory(taskMemory),
        taskMemoryUpdated: false,
        usedRag: false,
        usedRetrievalEnhancements: false,
        modelCalled: true,
      };
    }

    if (!index) throw new Error('Сначала перестройте локальный индекс в настройках плагина.');
    const memoryUpdate = await updateTaskMemory(
      normalizedQuestion,
      history,
      taskMemory,
      this.llm,
      llmConfig,
    );
    const activeMemory = memoryUpdate.memory;
    const rewrite = options.useRetrievalEnhancements
      ? await rewriteSearchQuery(normalizedQuestion, history, this.llm, llmConfig, activeMemory)
      : { query: normalizedQuestion, rewritten: false, failed: false };
    const retrievalOptions = options.useRetrievalEnhancements
      ? {
          candidateTopK: options.candidateTopK,
          finalTopK: options.finalTopK,
          minimumScore: options.similarityThreshold,
          expandRelevantSources: true,
        }
      : {
          candidateTopK: options.finalTopK,
          finalTopK: options.finalTopK,
          minimumScore: -1,
          expandRelevantSources: false,
        };
    const retrieval = await this.retrieval.search(
      rewrite.query,
      index,
      retrievalOptions,
      backendSearch,
    );
    const sources = selectSourcesForContext(retrieval.results);
    const diagnostics: RetrievalDiagnostics = {
      originalQuery: normalizedQuestion,
      searchQuery: rewrite.query,
      queryRewritten: rewrite.rewritten,
      rewriteFailed: rewrite.failed,
      candidateCount: retrieval.candidateCount,
      resultCount: sources.length,
      candidateTopK: retrievalOptions.candidateTopK,
      finalTopK: retrievalOptions.finalTopK,
      similarityThreshold: options.useRetrievalEnhancements
        ? options.similarityThreshold
        : null,
      taskMemoryUpdateFailed: memoryUpdate.failed || undefined,
    };
    if (sources.length === 0) {
      return {
        text: 'Не знаю: в локальном индексе нет фрагментов выше порога релевантности. Пожалуйста, уточните вопрос.',
        sources: [],
        citations: [],
        groundingStatus: 'not-enough-context',
        taskMemory: activeMemory,
        taskMemoryUpdated: memoryUpdate.updated,
        usedRag: true,
        usedRetrievalEnhancements: options.useRetrievalEnhancements,
        modelCalled: false,
        retrieval: diagnostics,
      };
    }

    const rawResponse = await this.llm.generate(
      buildRagMessages(normalizedQuestion, sources, history, activeMemory),
      llmConfig,
    );
    let grounded;
    try {
      grounded = parseGroundedResponse(rawResponse, sources);
    } catch (error) {
      if (!(error instanceof GroundingValidationError)) throw error;
      diagnostics.groundingRepairAttempted = true;
      const repairedResponse = await this.llm.generate(
        buildGroundingRepairMessages(
          normalizedQuestion,
          sources,
          history,
          rawResponse,
          error.issues,
          activeMemory,
        ),
        llmConfig,
      );
      try {
        grounded = parseGroundedResponse(repairedResponse, sources);
      } catch (repairError) {
        if (!(repairError instanceof GroundingValidationError)) throw repairError;
        diagnostics.groundingValidationFailed = true;
        return {
          text: 'Не знаю: не удалось подтвердить ответ дословными цитатами из найденных заметок. Пожалуйста, уточните вопрос.',
          sources,
          citations: [],
          groundingStatus: 'not-enough-context',
          taskMemory: activeMemory,
          taskMemoryUpdated: memoryUpdate.updated,
          usedRag: true,
          usedRetrievalEnhancements: options.useRetrievalEnhancements,
          modelCalled: true,
          retrieval: diagnostics,
        };
      }
    }
    return {
      text: grounded.answer,
      sources,
      citations: grounded.citations,
      groundingStatus: grounded.status,
      taskMemory: activeMemory,
      taskMemoryUpdated: memoryUpdate.updated,
      usedRag: true,
      usedRetrievalEnhancements: options.useRetrievalEnhancements,
      modelCalled: true,
      retrieval: diagnostics,
    };
  }
}
