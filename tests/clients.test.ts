import { describe, expect, it } from 'vitest';
import { OllamaEmbeddingClient } from '../src/embeddings/ollama-embedding-client';
import { ConfigurableLlmClient } from '../src/llm/llm-client';
import type { HttpRequest, HttpResponse, HttpTransport } from '../src/infrastructure/http';

class FakeTransport implements HttpTransport {
  requests: HttpRequest[] = [];

  constructor(private readonly response: unknown) {}

  async request<T>(request: HttpRequest): Promise<HttpResponse<T>> {
    this.requests.push(request);
    return { status: 200, data: this.response as T, text: JSON.stringify(this.response) };
  }
}

describe('model clients', () => {
  it('uses fixed Qwen model for Ollama embeddings', async () => {
    const transport = new FakeTransport({ embeddings: [[1, 2], [3, 4]] });
    const client = new OllamaEmbeddingClient(transport);
    await expect(client.embed(['one', 'two'])).resolves.toEqual([[1, 2], [3, 4]]);
    expect(transport.requests[0]?.body).toMatchObject({
      model: 'qwen3-embedding:0.6b',
      truncate: false,
    });
  });

  it('builds OpenAI-compatible requests without leaking configuration elsewhere', async () => {
    const transport = new FakeTransport({
      output: [{ content: [{ type: 'output_text', text: 'Answer [S1]' }] }],
    });
    const client = new ConfigurableLlmClient(transport);
    await expect(
      client.generate([{ role: 'user', content: 'Question' }], {
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1/',
        model: 'test-model',
        apiKey: 'secret',
      }),
    ).resolves.toBe('Answer [S1]');
    expect(transport.requests[0]).toMatchObject({
      url: 'https://api.openai.com/v1/responses',
      headers: { Authorization: 'Bearer secret' },
    });
  });

  it('requires a key for remote providers', async () => {
    const client = new ConfigurableLlmClient(new FakeTransport({}));
    await expect(
      client.generate([], {
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-flash',
      }),
    ).rejects.toThrow(/API key/i);
  });

  it('allows a keyless custom loopback provider', async () => {
    const transport = new FakeTransport({ choices: [{ message: { content: 'OK' } }] });
    const client = new ConfigurableLlmClient(transport);
    await expect(
      client.generate([{ role: 'user', content: 'Question' }], {
        provider: 'custom',
        baseUrl: 'http://localhost:8000/v1',
        model: 'local-model',
      }),
    ).resolves.toBe('OK');
  });

  it('rejects plaintext remote endpoints', async () => {
    const client = new ConfigurableLlmClient(new FakeTransport({}));
    await expect(
      client.generate([], {
        provider: 'custom',
        baseUrl: 'http://example.com/v1',
        model: 'model',
      }),
    ).rejects.toThrow(/HTTPS/i);
  });

  it('does not report a successful connection when the provider returns no models', async () => {
    const client = new ConfigurableLlmClient(new FakeTransport({ data: [] }));
    await expect(
      client.testConnection({
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'test-model',
        apiKey: 'secret',
      }),
    ).rejects.toThrow(/no models/i);
  });
});
