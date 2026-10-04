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
      body: {
        model: 'test-model',
        max_output_tokens: 1200,
        reasoning: { effort: 'none' },
        text: { verbosity: 'low' },
      },
    });
  });

  it('rejects arbitrary endpoints before sending the OpenAI key', async () => {
    const transport = new FakeTransport({});
    const client = new ConfigurableLlmClient(transport);
    await expect(
      client.generate([], {
        provider: 'openai',
        baseUrl: 'https://example.com/v1',
        model: 'gpt-5.4-mini-2026-03-17',
        apiKey: 'secret',
      }),
    ).rejects.toThrow(/OpenAI/);
    expect(transport.requests).toEqual([]);
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

  it('uses the official DeepSeek Chat Completions API with thinking disabled', async () => {
    const transport = new FakeTransport({ choices: [{ message: { content: 'Ответ [S1]' } }] });
    const client = new ConfigurableLlmClient(transport);
    await expect(
      client.generate([{ role: 'user', content: 'Вопрос' }], {
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-flash',
        apiKey: 'secret',
      }),
    ).resolves.toBe('Ответ [S1]');
    expect(transport.requests[0]).toMatchObject({
      url: 'https://api.deepseek.com/chat/completions',
      method: 'POST',
      headers: { Authorization: 'Bearer secret' },
      body: {
        model: 'deepseek-flash',
        stream: false,
        max_tokens: 1200,
        temperature: 0.2,
        thinking: { type: 'disabled' },
      },
    });
  });

  it('rejects arbitrary endpoints before sending the DeepSeek key', async () => {
    const transport = new FakeTransport({});
    const client = new ConfigurableLlmClient(transport);
    await expect(
      client.generate([], {
        provider: 'deepseek',
        baseUrl: 'https://example.com',
        model: 'deepseek-flash',
        apiKey: 'secret',
      }),
    ).rejects.toThrow(/DeepSeek/);
    expect(transport.requests).toEqual([]);
  });

  it('sends GLM requests only to the standard Z.AI API', async () => {
    const transport = new FakeTransport({ choices: [{ message: { content: 'Ответ [S1]' } }] });
    const client = new ConfigurableLlmClient(transport);
    await expect(
      client.generate([{ role: 'user', content: 'Вопрос' }], {
        provider: 'glm',
        baseUrl: 'https://api.z.ai/api/paas/v4',
        model: 'glm-5.3',
        apiKey: 'secret',
      }),
    ).resolves.toBe('Ответ [S1]');
    expect(transport.requests[0]).toMatchObject({
      url: 'https://api.z.ai/api/paas/v4/chat/completions',
      headers: { Authorization: 'Bearer secret' },
      body: {
        model: 'glm-5.3',
        stream: false,
        max_tokens: 1200,
        temperature: 0.2,
      },
    });
  });

  it('rejects coding-plan and arbitrary endpoints before sending the GLM token', async () => {
    const transport = new FakeTransport({});
    const client = new ConfigurableLlmClient(transport);
    for (const baseUrl of [
      'https://api.z.ai/api/coding/paas/v4',
      'https://example.com/v4',
      'https://api.z.ai/api/paas/v4?redirect=example.com',
    ]) {
      await expect(
        client.generate([], {
          provider: 'glm',
          baseUrl,
          model: 'glm-5.3',
          apiKey: 'secret',
        }),
      ).rejects.toThrow();
    }
    expect(transport.requests).toEqual([]);
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

  it('tests DeepSeek through the same Chat Completions API used by the chat', async () => {
    const transport = new FakeTransport({ choices: [{ message: { content: 'OK' } }] });
    const client = new ConfigurableLlmClient(transport);
    await client.testConnection({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      apiKey: 'secret',
    });
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]).toMatchObject({
      url: 'https://api.deepseek.com/chat/completions',
      method: 'POST',
      headers: { Authorization: 'Bearer secret' },
      body: { model: 'deepseek-flash' },
    });
  });
});
