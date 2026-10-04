import { describe, expect, it } from 'vitest';
import {
  EMPTY_TASK_MEMORY,
  buildTaskMemoryMessages,
  parseTaskMemory,
  updateTaskMemory,
} from '../src/rag/task-memory';
import type { LlmClient, LlmConfig, LlmMessage } from '../src/types';

const config: LlmConfig = {
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  apiKey: 'secret',
};

describe('task memory', () => {
  it('parses and bounds goals, clarifications, constraints, and terms', () => {
    const memory = parseTaskMemory(JSON.stringify({
      goal: 'Подготовить план тренировки',
      clarified_facts: ['Тренировки дважды в неделю', 'тренировки дважды в неделю'],
      constraints: ['Без занятий по воскресеньям'],
      terms: [
        { term: 'BJJ', meaning: 'бразильское джиу-джитсу' },
        { term: 'bjj', meaning: 'дубликат' },
      ],
    }));
    expect(memory).toEqual({
      goal: 'Подготовить план тренировки',
      clarifiedFacts: ['Тренировки дважды в неделю'],
      constraints: ['Без занятий по воскресеньям'],
      terms: [{ term: 'BJJ', meaning: 'бразильское джиу-джитсу' }],
    });
  });

  it('builds a bounded update prompt from current memory and recent history', () => {
    const messages = buildTaskMemoryMessages('Добавь ограничение', [
      { role: 'user', content: 'Цель — подобрать блюда' },
      { role: 'assistant', content: 'Предложение ассистента не является фактом' },
    ], EMPTY_TASK_MEMORY);
    const serialized = JSON.stringify(messages);
    expect(serialized).toContain('Добавь ограничение');
    expect(serialized).toContain('Цель — подобрать блюда');
    expect(serialized).not.toContain('Предложение ассистента не является фактом');
    expect(serialized).toContain('Не переноси в память предположения');
  });

  it('preserves the previous memory when the model response is invalid', async () => {
    const previous = {
      goal: 'Сохранить цель',
      clarifiedFacts: ['Факт'],
      constraints: ['Ограничение'],
      terms: [],
    };
    const llm: LlmClient = {
      async generate(_messages: LlmMessage[]): Promise<string> {
        return 'not json';
      },
      async testConnection(): Promise<void> {},
    };
    const result = await updateTaskMemory('Новый вопрос', [], previous, llm, config);
    expect(result).toEqual({ memory: previous, updated: false, failed: true });
    expect(result.memory).not.toBe(previous);
  });
});
