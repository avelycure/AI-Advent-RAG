import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { indexedChunk } from './test-fixtures';
import {
  MAX_PERSISTED_CHAT_ENTRIES,
  MAX_DIALOGS,
  newChatDialog,
  compactChatState,
  emptyChatState,
  sanitizeChatState,
} from '../src/ui/chat-state';
import { CHAT_STATE_FILENAME, ChatStateRepository } from '../src/ui/chat-state-repository';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe('persistent chat state', () => {
  it('keeps a bounded history and strips vectors and full chunk text', () => {
    const state = emptyChatState();
    state.dialogs.push(newChatDialog(null));
    state.dialogs[0]!.entries = Array.from({ length: MAX_PERSISTED_CHAT_ENTRIES + 5 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: `Сообщение ${index}`,
      usedRag: true,
      usedRetrievalEnhancements: true,
      sources: [{
        sourceId: 'S1',
        score: 0.9,
        chunk: indexedChunk('chunk', [1, 2], { text: 'Полный текст заметки' }),
      }],
    }));
    const compact = compactChatState(state);
    expect(compact.dialogs[0]!.entries).toHaveLength(MAX_PERSISTED_CHAT_ENTRIES);
    expect(compact.dialogs[0]!.entries[0]?.content).toBe('Сообщение 5');
    expect(compact.dialogs[0]!.entries[0]?.sources?.[0]?.chunk.text).toBe('');
    expect(compact.dialogs[0]!.entries[0]?.sources?.[0]?.chunk.vector).toEqual([]);
  });

  it('atomically saves and loads history without task memory with private permissions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ai-advent-chat-state-'));
    temporaryDirectories.push(directory);
    const repository = new ChatStateRepository(directory);
    const state = emptyChatState();
    state.dialogs.push(newChatDialog(null));
    state.dialogs[0]!.entries.push({ role: 'user', content: 'Цель — составить план', usedRag: true });
    await repository.save(state);

    const loaded = await repository.load();
    expect(loaded.dialogs[0]!.entries[0]?.content).toBe('Цель — составить план');
    expect(loaded).not.toHaveProperty('taskMemories');
    expect((await stat(join(directory, CHAT_STATE_FILENAME))).mode & 0o777).toBe(0o600);
  });

  it('drops legacy task memory while preserving the conversation', () => {
    const migrated = sanitizeChatState({ entries: [{ role: 'user', content: 'Привет' }],
      taskMemories: { 'rag-enhanced': { goal: 'Old goal' } } });
    expect(migrated.dialogs[0]!.entries).toHaveLength(1);
    expect(migrated).not.toHaveProperty('taskMemories');
  });

  it('limits dialog count, rejects duplicate IDs, and restores a valid selection', () => {
    const first = newChatDialog('Проекты/План.md');
    const state = sanitizeChatState({ dialogs: [first, first, ...Array.from({ length: 15 }, () => newChatDialog(null))], activeDialogId: 'missing' });
    expect(state.dialogs).toHaveLength(MAX_DIALOGS);
    expect(new Set(state.dialogs.map((dialog) => dialog.id)).size).toBe(MAX_DIALOGS);
    expect(state.activeDialogId).toBe(first.id);
    expect(state.dialogs[0]?.contextPath).toBe('Проекты/План.md');
  });

  it('reports corrupted state instead of silently losing history', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ai-advent-chat-state-'));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, CHAT_STATE_FILENAME), '{invalid');
    const repository = new ChatStateRepository(directory);
    await expect(repository.load()).rejects.toThrow(/повреждён/u);
    expect(await readFile(join(directory, CHAT_STATE_FILENAME), 'utf8')).toBe('{invalid');
  });

  it('serializes concurrent saves and clear operations without temporary-file races', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ai-advent-chat-state-'));
    temporaryDirectories.push(directory);
    const repository = new ChatStateRepository(directory);
    const first = emptyChatState();
    first.dialogs.push(newChatDialog(null));
    first.dialogs[0]!.entries.push({ role: 'user', content: 'Первое состояние', usedRag: true });
    const second = emptyChatState();
    second.dialogs.push(newChatDialog(null));
    second.dialogs[0]!.entries.push({ role: 'user', content: 'Второе состояние', usedRag: true });

    await Promise.all([repository.save(first), repository.save(second)]);
    expect((await repository.load()).dialogs[0]!.entries[0]?.content).toBe('Второе состояние');

    await Promise.all([repository.save(first), repository.clear()]);
    expect(await repository.load()).toEqual(expect.objectContaining({ dialogs: [] }));
  });
});
