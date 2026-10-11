import { describe, expect, it } from 'vitest';
import { ModelTaskQueue } from '../src/llm/model-task-queue';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('shared model task queue', () => {
  it('runs ten tasks strictly in arrival order with a maximum concurrency of one', async () => {
    const queue = new ModelTaskQueue();
    const gate = deferred<void>();
    const started: number[] = [];
    let concurrent = 0;
    let peak = 0;
    const positions: number[][] = Array.from({ length: 10 }, () => []);
    const jobs = Array.from({ length: 10 }, (_, index) => queue.enqueue(async () => {
      started.push(index);
      peak = Math.max(peak, ++concurrent);
      if (index === 0) await gate.promise;
      await Promise.resolve();
      concurrent--;
      return index;
    }, (position) => positions[index]!.push(position)));
    await Promise.resolve();
    expect(started).toEqual([0]);
    expect(queue.pendingCount).toBe(9);
    expect(positions[9]?.at(-1)).toBe(9);
    gate.resolve();
    expect(await Promise.all(jobs)).toEqual(Array.from({ length: 10 }, (_, i) => i));
    expect(peak).toBe(1);
    expect(started).toEqual(Array.from({ length: 10 }, (_, i) => i));
    expect(positions.every((values) => values.at(-1) === 0)).toBe(true);
  });
  it('continues after a task fails', async () => {
    const queue = new ModelTaskQueue();
    const failing = queue.enqueue(async () => { throw new Error('offline'); });
    const next = queue.enqueue(async () => 'next');
    await expect(failing).rejects.toThrow('offline');
    await expect(next).resolves.toBe('next');
  });
  it('rejects waiting tasks on shutdown', async () => {
    const queue = new ModelTaskQueue();
    const gate = deferred<void>();
    const running = queue.enqueue(() => gate.promise);
    const pending = queue.enqueue(async () => 'pending');
    queue.dispose();
    await expect(pending).rejects.toThrow(/отменён/);
    await expect(queue.enqueue(async () => 'new')).rejects.toThrow(/остановлена/);
    gate.resolve();
    await running;
  });
});
