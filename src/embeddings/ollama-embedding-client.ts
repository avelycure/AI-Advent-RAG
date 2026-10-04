import type { HttpTransport } from '../infrastructure/http';
import { joinUrl } from '../infrastructure/http';
import { EMBEDDING_MODEL, OLLAMA_BASE_URL, type EmbeddingClient } from '../types';

interface EmbedResponse {
  embeddings?: number[][];
}

interface TagsResponse {
  models?: Array<{ name?: string; model?: string; digest?: string }>;
}

export class OllamaEmbeddingClient implements EmbeddingClient {
  constructor(
    private readonly transport: HttpTransport,
    private readonly baseUrl = OLLAMA_BASE_URL,
  ) {}

  async embed(input: string[]): Promise<number[][]> {
    if (input.length === 0) return [];
    const response = await this.transport.request<EmbedResponse>({
      url: joinUrl(this.baseUrl, '/api/embed'),
      method: 'POST',
      body: { model: EMBEDDING_MODEL, input, truncate: false },
    });
    const embeddings = response.data.embeddings;
    if (!embeddings || embeddings.length !== input.length) {
      throw new Error('Ollama вернула некорректный ответ с эмбеддингами.');
    }
    const dimension = embeddings[0]?.length ?? 0;
    if (
      dimension === 0 ||
      embeddings.some(
        (vector) => vector.length !== dimension || !vector.every((value) => Number.isFinite(value)),
      )
    ) {
      throw new Error('Ollama вернула некорректные векторы или векторы разной размерности.');
    }
    return embeddings;
  }

  async testConnection(): Promise<void> {
    await this.getFingerprint();
  }

  async getFingerprint(): Promise<string> {
    const response = await this.transport.request<TagsResponse>({
      url: joinUrl(this.baseUrl, '/api/tags'),
    });
    const installed = response.data.models?.find((model) => {
      const name = model.model ?? model.name ?? '';
      return name === EMBEDDING_MODEL || name.startsWith(`${EMBEDDING_MODEL}:`);
    });
    if (!installed) {
      throw new Error(`Ollama запущена, но модель ${EMBEDDING_MODEL} не установлена.`);
    }
    return installed.digest || EMBEDDING_MODEL;
  }
}
