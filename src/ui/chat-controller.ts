import type { ActiveNoteContext, ChatProgress, ChatTurn, RagAnswer } from '../types';
import { ModelTaskQueue } from '../llm/model-task-queue';
import { emptyChatState, MAX_PERSISTED_CHAT_ENTRIES, MAX_DIALOGS, newChatDialog, type ChatDialog, type ChatState } from './chat-state';

export interface ChatStore {
  load(): Promise<ChatState>;
  save(state: ChatState): Promise<void>;
}
export interface ChatControllerApi {
  activeNotePath(): string | null;
  readNote(path: string): Promise<ActiveNoteContext>;
  answer(question: string, history: readonly ChatTurn[], context: ActiveNoteContext | undefined,
    onProgress: (progress: ChatProgress) => void): Promise<RagAnswer>;
  onError(message: string): void;
}
export interface DialogRuntime {
  phase: 'idle' | 'queued' | 'running';
  position: number;
  text: string;
  status: string;
  error?: string;
}
const idle = (): DialogRuntime => ({ phase: 'idle', position: 0, text: '', status: '' });

/** Shared by every panel; asynchronous completions always update their original dialog. */
export class ChatController {
  state = emptyChatState();
  readonly drafts = new Map<string, string>();
  private runtimes = new Map<string, DialogRuntime>();
  private listeners = new Set<(kind: 'change' | 'progress') => void>();
  private initialization?: Promise<void>;
  private disposed = false;

  dispose(): void { this.disposed = true; this.listeners.clear(); }

  constructor(private readonly store: ChatStore, private readonly queue: ModelTaskQueue,
    private readonly api: ChatControllerApi) {
    queue.subscribe(() => this.emit('progress'));
  }

  initialize(createIfEmpty = true): Promise<void> {
    this.initialization ??= (async () => {
      this.state = await this.store.load();
      for (const dialog of this.state.dialogs) {
        if (dialog.entries.at(-1)?.role === 'user') {
          this.runtimes.set(dialog.id, { ...idle(), status: 'Предыдущий запрос прерван. Отправьте сообщение снова.' });
        }
      }
    })();
    return this.initialization.then(() => {
      if (createIfEmpty && this.state.dialogs.length === 0 && !this.disposed) this.createDialog();
    });
  }

  subscribe(listener: (kind: 'change' | 'progress') => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  runtime(id: string): DialogRuntime { return this.runtimes.get(id) ?? idle(); }
  get activeDialog(): ChatDialog | undefined { return this.state.dialogs.find((d) => d.id === this.state.activeDialogId); }
  get queueSummary(): string {
    return `Модель: ${this.queue.isRunning ? 'занята' : 'свободна'} · в очереди: ${this.queue.pendingCount}`;
  }

  createDialog(): ChatDialog {
    if (this.state.dialogs.length >= MAX_DIALOGS) throw new Error('Можно открыть не более 10 диалогов. Удалите один из существующих.');
    const path = this.api.activeNotePath();
    const title = path ? path.split('/').at(-1)!.replace(/\.md$/u, '') : `Диалог ${this.state.dialogs.length + 1}`;
    const dialog = newChatDialog(path, title);
    this.state.dialogs.push(dialog);
    this.state.activeDialogId = dialog.id;
    this.changed();
    return dialog;
  }
  selectDialog(id: string): void {
    this.requireDialog(id);
    this.state.activeDialogId = id;
    this.changed();
  }
  moveDialog(id: string, targetId: string, after = false): void {
    const dialog = this.requireDialog(id);
    this.requireDialog(targetId);
    if (id === targetId) return;
    const reordered = this.state.dialogs.filter((item) => item.id !== id);
    const targetIndex = reordered.findIndex((item) => item.id === targetId);
    reordered.splice(targetIndex + (after ? 1 : 0), 0, dialog);
    if (reordered.every((item, index) => item === this.state.dialogs[index])) return;
    this.state.dialogs = reordered;
    this.changed();
  }
  removeContext(id: string): void {
    if (this.runtime(id).phase === 'running') throw new Error('Дождитесь ответа, чтобы убрать заметку из контекста.');
    this.requireDialog(id).contextPath = null;
    this.changed();
  }
  clearDialog(id: string): void {
    this.requireIdle(id);
    this.requireDialog(id).entries = [];
    this.runtimes.delete(id);
    this.changed();
  }
  deleteDialog(id: string): void {
    this.requireIdle(id);
    this.requireDialog(id);
    this.state.dialogs = this.state.dialogs.filter((dialog) => dialog.id !== id);
    this.runtimes.delete(id);
    this.drafts.delete(id);
    if (this.state.activeDialogId === id) this.state.activeDialogId = this.state.dialogs[0]?.id ?? null;
    if (this.state.dialogs.length === 0) this.createDialog();
    else this.changed();
  }
  renameNote(oldPath: string, newPath: string): void {
    let changed = false;
    for (const dialog of this.state.dialogs) {
      if (dialog.contextPath === oldPath) { dialog.contextPath = newPath; changed = true; }
      else if (dialog.contextPath?.startsWith(`${oldPath}/`)) {
        dialog.contextPath = newPath + dialog.contextPath.slice(oldPath.length); changed = true;
      }
    }
    if (changed) this.changed();
  }

  async send(id: string, question: string): Promise<void> {
    if (this.disposed) throw new Error('Плагин закрыт.');
    const value = question.trim();
    if (!value || value.length > 4000) throw new Error('Введите сообщение длиной от 1 до 4 000 символов.');
    this.requireIdle(id);
    const dialog = this.requireDialog(id);
    const history = dialog.entries.map(({ role, content }) => ({ role, content }));
    const userEntry = { role: 'user' as const, content: value, usedRag: true, usedRetrievalEnhancements: true };
    dialog.entries.push(userEntry);
    this.drafts.set(id, '');
    const runtime: DialogRuntime = { phase: 'queued', position: 0, text: '', status: 'В очереди…' };
    this.runtimes.set(id, runtime);
    this.changed();
    try {
      const answer = await this.queue.enqueue(async () => {
        // Read the originally attached note at task start, including changes made while waiting.
        const context = dialog.contextPath ? await this.api.readNote(dialog.contextPath) : undefined;
        return this.api.answer(value, history, context, (progress) => {
          if (progress.kind === 'stage') runtime.status = progress.text;
          else { runtime.text += progress.text; runtime.status = 'Qwen отвечает…'; }
          this.emit('progress');
        });
      }, (position) => {
        runtime.position = position;
        runtime.phase = position === 0 ? 'running' : 'queued';
        runtime.status = position === 0 ? 'Подключаюсь к локальной Qwen…' : `В очереди: ${position}`;
        this.emit('progress');
      });
      if (this.disposed) return;
      dialog.entries.push({ role: 'assistant', content: answer.text, sources: answer.sources,
        citations: answer.citations, groundingStatus: answer.groundingStatus, usedRag: true,
        usedRetrievalEnhancements: true, modelCalled: true, retrieval: answer.retrieval });
      runtime.status = 'Ответ получен.';
    } catch (error) {
      if (this.disposed) return;
      runtime.error = error instanceof Error ? error.message : String(error);
      runtime.status = 'Не удалось получить ответ.';
      const index = dialog.entries.indexOf(userEntry);
      if (index >= 0) dialog.entries.splice(index, 1);
      this.drafts.set(id, value);
    } finally {
      runtime.phase = 'idle';
      runtime.text = '';
      if (!this.disposed) {
        dialog.entries = dialog.entries.slice(-MAX_PERSISTED_CHAT_ENTRIES);
        this.changed();
      }
    }
  }

  private requireDialog(id: string): ChatDialog {
    const dialog = this.state.dialogs.find((d) => d.id === id);
    if (!dialog) throw new Error('Диалог не найден.');
    return dialog;
  }
  private requireIdle(id: string): void {
    if (this.runtime(id).phase !== 'idle') throw new Error('В этом диалоге уже есть запрос. Дождитесь ответа.');
  }
  private changed(): void {
    if (this.disposed) return;
    void this.store.save(this.state).catch((error: unknown) => this.api.onError(
      `Не удалось сохранить диалоги: ${error instanceof Error ? error.message : String(error)}`));
    this.emit('change');
  }
  private emit(kind: 'change' | 'progress'): void {
    if (this.disposed) return;
    for (const listener of this.listeners) listener(kind);
  }
}
