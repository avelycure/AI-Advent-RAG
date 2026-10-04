import { describe, expect, it } from 'vitest';
import { historyForMode } from '../src/ui/chat-history';

describe('chat history modes', () => {
  it('does not carry note-derived RAG answers into direct requests', () => {
    const entries = [
      { role: 'user' as const, content: 'RAG question', usedRag: true },
      { role: 'assistant' as const, content: 'Private note answer [S1]', usedRag: true },
      { role: 'user' as const, content: 'Direct question', usedRag: false },
      { role: 'assistant' as const, content: 'Direct answer', usedRag: false },
    ];

    expect(historyForMode(entries, false)).toEqual([
      { role: 'user', content: 'Direct question' },
      { role: 'assistant', content: 'Direct answer' },
    ]);
    expect(JSON.stringify(historyForMode(entries, false))).not.toContain('Private note answer');
  });

  it('keeps baseline and enhanced RAG histories separate', () => {
    const entries = [
      { role: 'user' as const, content: 'Baseline', usedRag: true, usedRetrievalEnhancements: false },
      { role: 'assistant' as const, content: 'Baseline answer', usedRag: true, usedRetrievalEnhancements: false },
      { role: 'user' as const, content: 'Enhanced', usedRag: true, usedRetrievalEnhancements: true },
      { role: 'assistant' as const, content: 'Enhanced answer', usedRag: true, usedRetrievalEnhancements: true },
    ];

    expect(historyForMode(entries, true, false).map((entry) => entry.content)).toEqual([
      'Baseline',
      'Baseline answer',
    ]);
    expect(historyForMode(entries, true, true).map((entry) => entry.content)).toEqual([
      'Enhanced',
      'Enhanced answer',
    ]);
  });
});
