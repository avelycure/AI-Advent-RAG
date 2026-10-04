import { describe, expect, it } from 'vitest';
import { normalizeRewrite, rewriteSearchQuery } from '../src/rag/query-rewriter';
import type { LlmClient, LlmConfig, LlmMessage } from '../src/types';

const config: LlmConfig = {
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  apiKey: 'secret',
};

class RewriterLlm implements LlmClient {
  constructor(private readonly response: string | Error) {}

  async generate(_messages: LlmMessage[], _config: LlmConfig): Promise<string> {
    if (this.response instanceof Error) throw this.response;
    return this.response;
  }

  async testConnection(): Promise<void> {}
}

describe('query rewriting', () => {
  it('normalizes a one-line model response', () => {
    expect(normalizeRewrite('Поисковый запрос: «Стивенс моральная ответственность»\nПояснение'))
      .toBe('Стивенс моральная ответственность');
  });

  it('falls back to the original question when the rewrite request fails', async () => {
    await expect(
      rewriteSearchQuery('Исходный вопрос', [], new RewriterLlm(new Error('offline')), config),
    ).resolves.toEqual({ query: 'Исходный вопрос', rewritten: false, failed: true });
  });

  it('returns a clean rewritten query', async () => {
    await expect(
      rewriteSearchQuery('А что с ним?', [], new RewriterLlm('- Стивенс и ответственность'), config),
    ).resolves.toEqual({
      query: 'Стивенс и ответственность',
      rewritten: true,
      failed: false,
    });
  });
});
