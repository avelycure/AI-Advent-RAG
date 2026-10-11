import { describe, expect, it } from 'vitest';
import { RagService } from '../src/rag/rag-service';
import type { ChatProgress, EmbeddingClient, LlmClient, LlmConfig, LlmMessage, RagPipelineOptions } from '../src/types';
import { indexedChunk, indexSnapshot } from './test-fixtures';

class Embeddings implements EmbeddingClient {
  calls: string[][] = [];
  async embed(input: string[]): Promise<number[][]> { this.calls.push(input); return [[1, 0]]; }
  async testConnection(): Promise<void> {}
  async getFingerprint(): Promise<string> { return 'digest'; }
}
class Llm implements LlmClient {
  calls: LlmMessage[][] = [];
  async generate(messages: LlmMessage[], _config: LlmConfig, onText?: (text: string) => void): Promise<string> {
    this.calls.push(messages);
    if (messages[0]?.content.includes('Переформулируй')) return 'самостоятельный запрос';
    onText?.('Сейчас отвечу. ');
    onText?.('Ответ [S1]');
    return 'Сейчас отвечу. Ответ [S1]';
  }
  async testConnection(): Promise<void> {}
}
const config: LlmConfig = { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.8:27b' };
const options: RagPipelineOptions = { candidateTopK: 10, finalTopK: 5, similarityThreshold: 0.35 };

describe('streaming RAG chat without context gates or task memory', () => {
  it('requires an index before making any model request', async () => {
    const llm = new Llm();
    await expect(new RagService(new Embeddings(), llm).answer('Вопрос', null, config, options)).rejects.toThrow(/индекс/);
    expect(llm.calls).toHaveLength(0);
  });
  it('passes notes and history to rewriting and generation without memory or repair', async () => {
    const llm = new Llm();
    const answer = await new RagService(new Embeddings(), llm).answer('Вопрос', indexSnapshot([indexedChunk('note')]), config, options,
      [{ role: 'user', content: 'Предыдущий вопрос' }]);
    expect(answer.text).toBe('Сейчас отвечу. Ответ [S1]');
    expect(answer.sources).toHaveLength(1);
    expect(answer.groundingStatus).toBe('not-applicable');
    expect(llm.calls).toHaveLength(2);
    expect(JSON.stringify(llm.calls)).not.toMatch(/Память задачи|Обнови структурированную|not_enough_context/);
    expect(llm.calls[1]).toContainEqual({ role: 'user', content: 'Предыдущий вопрос' });
  });
  it('generates an answer when filtering removes every source', async () => {
    const llm = new Llm();
    const answer = await new RagService(new Embeddings(), llm).answer('Вопрос', indexSnapshot([indexedChunk('note', [0, 1])]), config,
      { ...options, similarityThreshold: 1 });
    expect(answer.sources).toHaveLength(0);
    expect(answer.modelCalled).toBe(true);
    expect(answer.text).toContain('Ответ');
    expect(llm.calls).toHaveLength(2);
  });
  it('generates with an empty index', async () => {
    const llm = new Llm();
    const answer = await new RagService(new Embeddings(), llm).answer('Вопрос', indexSnapshot([]), config, options);
    expect(answer.modelCalled).toBe(true);
    expect(answer.sources).toHaveLength(0);
  });
  it('emits stages followed by actual model text', async () => {
    const progress: ChatProgress[] = [];
    await new RagService(new Embeddings(), new Llm()).answer('Вопрос', indexSnapshot([indexedChunk('note')]), config, options, [], undefined,
      (event) => progress.push(event));
    expect(progress[0]?.kind).toBe('stage');
    expect(progress.filter((event) => event.kind === 'text').map((event) => event.text).join('')).toBe('Сейчас отвечу. Ответ [S1]');
  });
  it('pins the active note despite retrieval filtering and bounds its text', async () => {
    const llm = new Llm();
    const context = { path: 'Active.md', title: 'Active', content: 'Текущая страница. ' + 'x'.repeat(15000), mtime: 1 };
    const answer = await new RagService(new Embeddings(), llm).answer('Объясни эту страницу',
      indexSnapshot([indexedChunk('unrelated', [0, 1])]), config, { ...options, similarityThreshold: 1 },
      [], undefined, undefined, context);
    expect(answer.sources).toHaveLength(1);
    expect(answer.sources[0]?.isActiveNote).toBe(true);
    expect(answer.sources[0]?.chunk.metadata.source).toBe('Active.md');
    expect(answer.sources[0]?.chunk.text.length).toBe(12000);
    expect(answer.sources[0]?.contextTruncated).toBe(true);
    expect(JSON.stringify(llm.calls[0])).toContain('Active.md');
    expect(JSON.stringify(llm.calls[1])).toContain('Текущая страница.');
  });

  it('still rejects invalid user input and missing index', async () => {
    const service = new RagService(new Embeddings(), new Llm());
    await expect(service.answer(' ', null, config, options)).rejects.toThrow(/Введите/);
    await expect(service.answer('a'.repeat(4001), null, config, options)).rejects.toThrow(/4 000/);
    await expect(service.answer('Вопрос', null, config, options)).rejects.toThrow(/индекс/);
  });
});
