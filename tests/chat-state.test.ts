import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { indexedChunk } from './test-fixtures';
import {
  MAX_PERSISTED_CHAT_ENTRIES,
  compactChatState,
  emptyChatState,
} from '../src/ui/chat-state';
import { CHAT_STATE_FILENAME, ChatStateRepository } from '../src/ui/chat-state-repository';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe('persistent chat state', () => {
  it('keeps a bounded history and strips vectors and full chunk text', () => {
    const state = emptyChatState();
    state.entries = Array.from({ length: MAX_PERSISTED_CHAT_ENTRIES + 5 }, (_, index) => ({
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
    expect(compact.entries).toHaveLength(MAX_PERSISTED_CHAT_ENTRIES);
    expect(compact.entries[0]?.content).toBe('Сообщение 5');
    expect(compact.entries[0]?.sources?.[0]?.chunk.text).toBe('');
    expect(compact.entries[0]?.sources?.[0]?.chunk.vector).toEqual([]);
  });

  it('atomically saves and loads history plus task memory with private permissions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ai-advent-chat-state-'));
    temporaryDirectories.push(directory);
    const repository = new ChatStateRepository(directory);
    const state = emptyChatState();
    state.entries.push({ role: 'user', content: 'Цель — составить план', usedRag: true });
    state.taskMemories['rag-enhanced'].goal = 'Составить план';
    await repository.save(state);

    const loaded = await repository.load();
    expect(loaded.entries[0]?.content).toBe('Цель — составить план');
    expect(loaded.taskMemories['rag-enhanced'].goal).toBe('Составить план');
    expect((await stat(join(directory, CHAT_STATE_FILENAME))).mode & 0o777).toBe(0o600);
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
    first.entries.push({ role: 'user', content: 'Первое состояние', usedRag: true });
    const second = emptyChatState();
    second.entries.push({ role: 'user', content: 'Второе состояние', usedRag: true });

    await Promise.all([repository.save(first), repository.save(second)]);
    expect((await repository.load()).entries[0]?.content).toBe('Второе состояние');

    await Promise.all([repository.save(first), repository.clear()]);
    expect(await repository.load()).toEqual(expect.objectContaining({ entries: [] }));
  });
});
