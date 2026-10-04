import { describe, expect, it } from 'vitest';
import { RagService } from '../src/rag/rag-service';
import type {
  EmbeddingClient,
  LlmClient,
  LlmConfig,
  LlmMessage,
  RagPipelineOptions,
} from '../src/types';
import { indexedChunk, indexSnapshot } from './test-fixtures';

class Embeddings implements EmbeddingClient {
  calls: string[][] = [];

  async embed(input: string[]): Promise<number[][]> {
    this.calls.push(input);
    return [[1, 0]];
  }

  async testConnection(): Promise<void> {}

  async getFingerprint(): Promise<string> {
    return 'digest';
  }
}

class Llm implements LlmClient {
  calls: Array<{ messages: LlmMessage[]; config: LlmConfig }> = [];

  async generate(messages: LlmMessage[], config: LlmConfig): Promise<string> {
    this.calls.push({ messages, config });
    if (messages[0]?.content.includes('Переформулируй последний вопрос')) {
      return 'самостоятельный поисковый запрос';
    }
    if (messages[0]?.content.includes('Обнови структурированную память')) {
      return JSON.stringify({
        goal: 'Ответить на вопрос по заметкам',
        clarified_facts: ['Пользователь уточнил предмет вопроса'],
        constraints: ['Использовать локальные заметки'],
        terms: [],
      });
    }
    if (messages[0]?.content.includes('У тебя нет доступа к заметкам')) return 'Ответ без RAG';
    const sourceMessage = [...messages].reverse().find((message) =>
      message.role === 'user' && message.content.includes('Источники в формате JSON:\n'),
    );
    if (!sourceMessage) throw new Error('Source payload missing from test prompt.');
    const serializedPayload = sourceMessage.content.split('Источники в формате JSON:\n')[1];
    const payload: unknown = JSON.parse(serializedPayload ?? 'null');
    if (!Array.isArray(payload) || !payload[0] || typeof payload[0] !== 'object') {
      throw new Error('Invalid source payload in test prompt.');
    }
    const source = payload[0] as Record<string, unknown>;
    return JSON.stringify({
      status: 'answered',
      answer: 'Ответ [S1]',
      sources: [{
        source_id: source.id,
        source: source.source,
        section: source.section,
        chunk_id: source.chunk_id,
        quote: source.content,
      }],
    });
  }

  async testConnection(): Promise<void> {}
}

class QueuedLlm extends Llm {
  constructor(private readonly answerResponses: string[]) {
    super();
  }

  override async generate(messages: LlmMessage[], requestConfig: LlmConfig): Promise<string> {
    if (messages[0]?.content.includes('Переформулируй последний вопрос')) {
      return super.generate(messages, requestConfig);
    }
    if (messages[0]?.content.includes('Обнови структурированную память')) {
      return super.generate(messages, requestConfig);
    }
    this.calls.push({ messages, config: requestConfig });
    return this.answerResponses.shift() ?? 'invalid';
  }
}

const config: LlmConfig = {
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  apiKey: 'secret',
};

function options(overrides: Partial<RagPipelineOptions> = {}): RagPipelineOptions {
  return {
    useRag: true,
    useRetrievalEnhancements: false,
    candidateTopK: 10,
    finalTopK: 5,
    similarityThreshold: 0.35,
    ...overrides,
  };
}

describe('RAG chat service', () => {
  it('does not touch embeddings or the index in direct mode', async () => {
    const embeddings = new Embeddings();
    const llm = new Llm();
    const service = new RagService(embeddings, llm);
    const answer = await service.answer(' Вопрос ', null, config, options({ useRag: false }));
    expect(answer).toEqual({
      text: 'Ответ без RAG',
      sources: [],
      citations: [],
      groundingStatus: 'not-applicable',
      taskMemory: { goal: null, clarifiedFacts: [], constraints: [], terms: [] },
      taskMemoryUpdated: false,
      usedRag: false,
      usedRetrievalEnhancements: false,
      modelCalled: true,
    });
    expect(embeddings.calls).toEqual([]);
    expect(JSON.stringify(llm.calls[0]?.messages)).not.toContain('Источники в формате JSON');
  });

  it('uses backend retrieval and returns exactly the sources sent to DeepSeek', async () => {
    const embeddings = new Embeddings();
    const llm = new Llm();
    const service = new RagService(embeddings, llm);
    let backendCalled = false;
    const answer = await service.answer(
      'Вопрос',
      indexSnapshot([
        indexedChunk('unused', [0, 1]),
        indexedChunk('sent', [1, 0], { text: 'Текст заметки' }),
      ]),
      config,
      options({ candidateTopK: 1, finalTopK: 1 }),
      [],
      async () => {
        backendCalled = true;
        return [{ index: 1, score: 0.91 }];
      },
    );
    expect(backendCalled).toBe(true);
    expect(embeddings.calls).toEqual([['Вопрос']]);
    expect(answer.sources.map((item) => item.chunk.metadata.chunk_id)).toEqual(['sent']);
    expect(answer.citations).toEqual([{
      sourceId: 'S1',
      source: 'sent.md',
      section: null,
      chunkId: 'sent',
      quote: 'Текст заметки',
    }]);
    expect(answer.groundingStatus).toBe('grounded');
    expect(answer.sources[0]?.sourceId).toBe('S1');
    expect(answer.taskMemory.goal).toBe('Ответить на вопрос по заметкам');
    expect(answer.taskMemoryUpdated).toBe(true);
    expect(JSON.stringify(llm.calls[1]?.messages)).toContain('Текст заметки');
  });

  it('does not call DeepSeek for answer generation when filtering removes every chunk', async () => {
    const llm = new Llm();
    const service = new RagService(new Embeddings(), llm);
    const answer = await service.answer(
      'Вопрос',
      indexSnapshot([indexedChunk('opposite', [-1, 0])]),
      config,
      options({ useRetrievalEnhancements: true }),
    );
    expect(answer.usedRag).toBe(true);
    expect(answer.modelCalled).toBe(false);
    expect(answer.sources).toEqual([]);
    expect(answer.citations).toEqual([]);
    expect(answer.groundingStatus).toBe('not-enough-context');
    expect(answer.text).toMatch(/^Не знаю:/u);
    expect(answer.text).toMatch(/уточните/iu);
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[0]?.messages[0]?.content).toContain('Обнови структурированную память');
    expect(llm.calls[1]?.messages[0]?.content).toContain('Переформулируй последний вопрос');
  });

  it('rejects an empty or oversized question before any model call', async () => {
    const embeddings = new Embeddings();
    const llm = new Llm();
    const service = new RagService(embeddings, llm);
    await expect(service.answer(' ', null, config, options({ useRag: false }))).rejects.toThrow(/вопрос/i);
    await expect(
      service.answer('x'.repeat(4001), null, config, options({ useRag: false })),
    ).rejects.toThrow(/4.*000/);
    expect(embeddings.calls).toEqual([]);
    expect(llm.calls).toEqual([]);
  });

  it('rewrites the query, filters candidates, and reports retrieval diagnostics', async () => {
    const embeddings = new Embeddings();
    const llm = new Llm();
    const service = new RagService(embeddings, llm);
    const answer = await service.answer(
      'А что было с ним?',
      indexSnapshot([
        indexedChunk('kept', [1, 0], { text: 'Релевантный текст' }),
        indexedChunk('filtered', [0, 1]),
      ]),
      config,
      options({ useRetrievalEnhancements: true, candidateTopK: 2, finalTopK: 2 }),
      [{ role: 'user', content: 'Мы говорили про фильм' }],
      async () => [
        { index: 0, score: 0.8 },
        { index: 1, score: 0.2 },
      ],
    );

    expect(embeddings.calls).toEqual([['самостоятельный поисковый запрос']]);
    expect(llm.calls).toHaveLength(3);
    expect(JSON.stringify(llm.calls[1]?.messages)).toContain('Ответить на вопрос по заметкам');
    expect(answer.sources.map((item) => item.chunk.metadata.chunk_id)).toEqual(['kept']);
    expect(answer.usedRetrievalEnhancements).toBe(true);
    expect(answer.retrieval).toMatchObject({
      originalQuery: 'А что было с ним?',
      searchQuery: 'самостоятельный поисковый запрос',
      queryRewritten: true,
      rewriteFailed: false,
      candidateCount: 2,
      resultCount: 1,
      similarityThreshold: 0.35,
    });
  });

  it('repairs an answer that contains no validated citation', async () => {
    const repaired = JSON.stringify({
      status: 'answered',
      answer: 'Подтверждённый ответ [S1].',
      sources: [{
        source_id: 'S1',
        source: 'sent.md',
        section: null,
        chunk_id: 'sent',
        quote: 'Текст заметки',
      }],
    });
    const llm = new QueuedLlm(['Ответ без JSON', repaired]);
    const service = new RagService(new Embeddings(), llm);
    const answer = await service.answer(
      'Вопрос',
      indexSnapshot([indexedChunk('sent', [1, 0], { text: 'Текст заметки' })]),
      config,
      options({ finalTopK: 1 }),
    );
    expect(answer.text).toBe('Подтверждённый ответ [S1].');
    expect(answer.citations).toHaveLength(1);
    expect(answer.retrieval?.groundingRepairAttempted).toBe(true);
    expect(answer.retrieval?.groundingValidationFailed).toBeUndefined();
    expect(llm.calls).toHaveLength(3);
  });

  it('returns a safe “не знаю” response when both grounding attempts fail', async () => {
    const llm = new QueuedLlm(['invalid', 'still invalid']);
    const service = new RagService(new Embeddings(), llm);
    const answer = await service.answer(
      'Вопрос',
      indexSnapshot([indexedChunk('sent', [1, 0], { text: 'Текст заметки' })]),
      config,
      options({ finalTopK: 1 }),
    );
    expect(answer.text).toMatch(/^Не знаю:/u);
    expect(answer.text).toMatch(/уточните/iu);
    expect(answer.citations).toEqual([]);
    expect(answer.groundingStatus).toBe('not-enough-context');
    expect(answer.retrieval?.groundingRepairAttempted).toBe(true);
    expect(answer.retrieval?.groundingValidationFailed).toBe(true);
    expect(llm.calls).toHaveLength(3);
  });
});
