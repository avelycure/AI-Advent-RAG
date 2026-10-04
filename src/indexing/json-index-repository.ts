import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { IndexRepository, VectorIndexSnapshot } from '../types';
import { validateSnapshot } from './index-repository';

interface JsonSnapshot extends Omit<VectorIndexSnapshot, 'chunks'> {
  chunks: Array<Omit<VectorIndexSnapshot['chunks'][number], 'vector'> & { vector: number[] }>;
}

export class JsonIndexRepository implements IndexRepository {
  readonly format = 'json' as const;

  constructor(private readonly filePath: string) {}

  async load(): Promise<VectorIndexSnapshot | null> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as JsonSnapshot;
      const snapshot: VectorIndexSnapshot = {
        ...parsed,
        chunks: parsed.chunks.map((chunk) => ({
          ...chunk,
          vector: new Float32Array(chunk.vector),
        })),
      };
      validateSnapshot(snapshot);
      return snapshot;
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw damagedIndexError(error);
    }
  }

  async save(snapshot: VectorIndexSnapshot): Promise<void> {
    validateSnapshot(snapshot);
    await mkdir(dirname(this.filePath), { recursive: true });
    const serialized: JsonSnapshot = {
      ...snapshot,
      chunks: snapshot.chunks.map((chunk) => ({
        ...chunk,
        vector: Array.from(chunk.vector),
      })),
    };
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(serialized, null, 2), 'utf8');
    await rename(temporaryPath, this.filePath);
  }
}

function isMissingFile(error: unknown): boolean {
  return Boolean(
    typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === 'ENOENT',
  );
}

function damagedIndexError(error: unknown): Error {
  const detail = error instanceof Error ? error.message : '';
  return new Error(`Локальный JSON-индекс повреждён. Перестройте его в настройках плагина. ${detail}`);
}
