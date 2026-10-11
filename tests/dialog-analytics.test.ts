import { expect, it } from 'vitest';
import { analyticsRows } from '../src/ui/dialog-analytics';
import { compactChatState, newChatDialog } from '../src/ui/chat-state';
import { ConfigurableLlmClient } from '../src/llm/llm-client';
import type { HttpTransport, HttpRequest } from '../src/infrastructure/http';
import type { ModelMetrics } from '../src/types';

it('reads final streaming counters, handles chunk boundaries and keeps memory optional', async () => {
  const captured: ModelMetrics[] = [];
  const transport: HttpTransport = {
    async request<T>(request: HttpRequest) {
      if (request.url.endsWith('/api/ps')) throw new Error('Unavailable');
      return { status: 200, data: {} as T, text: '{}' };
    },
    async requestStream(_request, chunk) {
      chunk('{"message":{"content":"Привет"},"done":false}\n{"done":tr');
      chunk('ue,"prompt_eval_count":100,"eval_count":20,"eval_duration":2000000000,"total_duration":3000000000}\n');
    },
  };
  const answer = await new ConfigurableLlmClient(transport).generate([{ role: 'user', content: 'Hi' }],
    { provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'qwen', onMetrics: (m) => captured.push(m) }, () => {});
  expect(answer).toBe('Привет');
  expect(captured).toHaveLength(1);
  expect(captured[0]).toMatchObject({ inputTokens: 100, outputTokens: 20, generationMs: 2000, totalMs: 3000 });
  expect(captured[0]!.firstTokenMs).toBeGreaterThanOrEqual(0);
  expect(captured[0]!.memoryBytes).toBeUndefined();
});

it('aggregates RAG calls without averaging rates and persists metrics', () => {
  const dialog = newChatDialog(null);
  dialog.entries.push({ role: 'assistant', content: 'Answer', analytics: { elapsedMs: 6000, queueMs: 500,
    calls: [{ model: 'qwen', inputTokens: 100, outputTokens: 10, generationMs: 1000 },
      { model: 'qwen', inputTokens: 200, outputTokens: 50, generationMs: 2000 }] } });
  const rows = Object.fromEntries(analyticsRows(dialog.entries));
  expect(rows['Скорость генерации']).toBe('20.0 ток/с');
  expect(rows['Токены вход / выход']).toBe('300 / 60');
  expect(rows['Память модели после ответа']).toBe('Нет данных');
  const restored = compactChatState({ version: 2, dialogs: [dialog], activeDialogId: dialog.id, updatedAt: 0 });
  expect(restored.dialogs[0]!.entries[0]!.analytics).toEqual(dialog.entries[0]!.analytics);
});

it('does not invent counters for old answers', () => {
  expect(analyticsRows([{ role: 'assistant', content: 'Old' }])).toEqual([]);
});

it('captures non-streaming counts and selects memory of the requested model', async () => {
  const captured: ModelMetrics[] = [];
  const transport: HttpTransport = {
    async request<T>(request: HttpRequest) {
      const data = request.url.endsWith('/api/show') ? {} : request.url.endsWith('/api/ps')
        ? { models: [{ model: 'embedding', size: 1 }, { model: 'qwen:latest', size: 2048, size_vram: 1024 }] }
        : { message: { content: 'query' }, prompt_eval_count: 12, eval_count: 3, eval_duration: 0 };
      return { status: 200, data: data as T, text: '' };
    },
  };
  await new ConfigurableLlmClient(transport).generate([{ role: 'user', content: 'Hi' }],
    { provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'qwen', onMetrics: (m) => captured.push(m) });
  expect(captured[0]).toMatchObject({ inputTokens: 12, outputTokens: 3, generationMs: 0, memoryBytes: 2048, vramBytes: 1024 });
  expect(captured[0]!.firstTokenMs).toBeUndefined();
  expect(Object.fromEntries(analyticsRows([{ role: 'assistant', content: 'query', analytics: { calls: captured, queueMs: 0, elapsedMs: 1 } }]))['Скорость генерации']).toBe('Нет данных');
});
