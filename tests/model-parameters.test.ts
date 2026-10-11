import { describe, expect, it } from 'vitest';
import { sanitizeModelParameters } from '../src/llm/model-parameters';
import { compactChatState, emptyChatState, newChatDialog, sanitizeChatState } from '../src/ui/chat-state';

describe('dialog model parameters', () => {
  it('migrates old dialogs and clamps corrupt values with room for the input', () => {
    const state = sanitizeChatState({ dialogs: [{ id: 'old', entries: [] }] });
    expect(state.dialogs[0]?.modelParameters).toEqual({ temperature: 0.1, repeat_penalty: 1, num_predict: 8192, num_ctx: 32768 });
    expect(sanitizeModelParameters({ temperature: Infinity, repeat_penalty: -2, num_predict: 999999, num_ctx: 8192 })).toEqual({ temperature: 0.1, repeat_penalty: 0.8, num_predict: 4096, num_ctx: 8192 });
  });
  it('keeps parameters through persistence and reordering', () => {
    const state = emptyChatState();
    const first = newChatDialog(null);
    const second = newChatDialog(null);
    first.modelParameters = { temperature: 0.6, repeat_penalty: 1.1, num_predict: 2048, num_ctx: 16384 };
    state.dialogs = [second, first];
    expect(compactChatState(state).dialogs[1]?.modelParameters).toEqual(first.modelParameters);
  });
});
