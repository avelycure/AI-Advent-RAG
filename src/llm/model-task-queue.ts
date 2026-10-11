interface QueueJob {
  run: () => Promise<void>;
  fail: (error: Error) => void;
  onPosition?: (position: number) => void;
}

/** One complete model task at a time, including rewriting, embeddings, and answering. */
export class ModelTaskQueue {
  private waiting: QueueJob[] = [];
  private running = false;
  private disposed = false;
  private listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  get pendingCount(): number { return this.waiting.length; }
  get isRunning(): boolean { return this.running; }

  enqueue<T>(run: () => Promise<T>, onPosition?: (position: number) => void, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new Error('Запрос отменён.'));
    if (this.disposed) return Promise.reject(new Error('Очередь остановлена. Откройте плагин заново.'));
    return new Promise<T>((resolve, reject) => {
      const cleanup = (): void => { signal?.removeEventListener('abort', abort); };
      const job: QueueJob = {
        run: async () => { cleanup(); try { signal?.throwIfAborted(); resolve(await run()); } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); } },
        fail: (error) => { cleanup(); reject(error); },
        onPosition,
      };
      const abort = (): void => {
        const index = this.waiting.indexOf(job);
        if (index < 0) return;
        this.waiting.splice(index, 1);
        job.fail(new Error('Запрос отменён.'));
        this.notifyPositions();
      };
      this.waiting.push(job);
      signal?.addEventListener('abort', abort, { once: true });
      this.notifyPositions();
      this.drain();
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const job of this.waiting.splice(0)) job.fail(new Error('Запрос отменён: плагин закрыт.'));
  }

  private notifyPositions(): void {
    this.waiting.forEach((job, index) => job.onPosition?.(index + 1));
    for (const listener of this.listeners) listener();
  }

  private drain(): void {
    if (this.running || this.disposed) return;
    const job = this.waiting.shift();
    if (!job) return;
    this.running = true;
    job.onPosition?.(0);
    this.notifyPositions();
    void Promise.resolve().then(job.run).finally(() => {
      this.running = false;
      this.drain();
      this.notifyPositions();
    });
  }
}
