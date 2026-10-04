import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { compactChatState, emptyChatState, sanitizeChatState, type ChatState } from './chat-state';

export const CHAT_STATE_FILENAME = 'rag-chat-state.json';

export class ChatStateRepository {
  private readonly path: string;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(pluginDirectory: string) {
    this.path = join(pluginDirectory, CHAT_STATE_FILENAME);
  }

  async load(): Promise<ChatState> {
    try {
      const raw = await readFile(this.path, 'utf8');
      return sanitizeChatState(JSON.parse(raw));
    } catch (error) {
      if (isMissingFile(error)) return emptyChatState();
      if (error instanceof SyntaxError) {
        throw new Error('Файл истории RAG-чата повреждён. Очистите чат в панели плагина.');
      }
      throw error;
    }
  }

  save(state: ChatState): Promise<void> {
    const compact = compactChatState(state);
    return this.enqueue(async () => {
      const temporaryPath = `${this.path}.tmp`;
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(temporaryPath, `${JSON.stringify(compact, null, 2)}\n`, { mode: 0o600 });
      await rename(temporaryPath, this.path);
    });
  }

  clear(): Promise<void> {
    return this.enqueue(async () => {
      try {
        await unlink(this.path);
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
    });
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.pendingWrite.then(operation, operation);
    this.pendingWrite = result.catch(() => undefined);
    return result;
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
