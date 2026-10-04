import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import type {
  IndexRepository,
  VectorIndexSnapshot,
  VectorSearchHit,
} from '../types';
import { validateSnapshot } from './index-repository';

interface FaissIndexLike {
  add(vectors: number[]): void;
  getDimension(): number;
  ntotal(): number;
  search(query: number[], topK: number): { distances: number[]; labels: number[] };
  write(filePath: string): void;
}

interface FaissModule {
  IndexFlatIP: {
    new (dimension: number): FaissIndexLike;
    read(filePath: string): FaissIndexLike;
  };
}

interface FaissSidecar extends Omit<VectorIndexSnapshot, 'chunks'> {
  format: 'faiss-index-flat-ip';
  indexSha256: string;
  chunks: Array<Omit<VectorIndexSnapshot['chunks'][number], 'vector'> & { vector: number[] }>;
}

export class FaissIndexRepository implements IndexRepository {
  readonly format = 'faiss' as const;
  private index: FaissIndexLike | null = null;

  constructor(
    private readonly filePath: string,
    private readonly metadataPath = `${filePath}.json`,
  ) {}

  async load(): Promise<VectorIndexSnapshot | null> {
    try {
      await Promise.all([access(this.filePath), access(this.metadataPath)]);
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }

    try {
      const [faiss, metadataText, indexBytes] = await Promise.all([
        loadFaiss(),
        readFile(this.metadataPath, 'utf8'),
        readFile(this.filePath),
      ]);
      const sidecar = JSON.parse(metadataText) as FaissSidecar;
      if (sidecar.format !== 'faiss-index-flat-ip') {
        throw new Error('Неизвестный тип FAISS-индекса.');
      }
      if (sidecar.indexSha256 !== sha256(indexBytes)) {
        throw new Error('FAISS-файл не соответствует контрольной сумме метаданных.');
      }
      const { format: _format, indexSha256: _indexSha256, ...serialized } = sidecar;
      const snapshot: VectorIndexSnapshot = {
        ...serialized,
        chunks: serialized.chunks.map((chunk) => ({
          ...chunk,
          vector: new Float32Array(chunk.vector),
        })),
      };
      validateSnapshot(snapshot);
      // Do not pass a persisted file to native read_index: FAISS does not validate input files.
      // The checksum couples the interoperable file to this sidecar; the in-memory search index is
      // reconstructed from already validated vectors to keep synced/corrupt files out of native I/O.
      const index = new faiss.IndexFlatIP(snapshot.vectorDimension);
      if (snapshot.chunks.length > 0) {
        index.add(snapshot.chunks.flatMap((chunk) => Array.from(chunk.vector)));
      }
      this.index = index;
      return snapshot;
    } catch (error) {
      throw damagedIndexError(error);
    }
  }

  async save(snapshot: VectorIndexSnapshot): Promise<void> {
    validateSnapshot(snapshot);
    await mkdir(dirname(this.filePath), { recursive: true });
    const faiss = await loadFaiss();
    const index = new faiss.IndexFlatIP(snapshot.vectorDimension);
    if (snapshot.chunks.length > 0) {
      index.add(snapshot.chunks.flatMap((chunk) => Array.from(chunk.vector)));
    }
    const temporaryIndexPath = `${this.filePath}.tmp`;
    const temporaryMetadataPath = `${this.metadataPath}.tmp`;
    index.write(temporaryIndexPath);
    const sidecar: FaissSidecar = {
      ...snapshot,
      format: 'faiss-index-flat-ip',
      indexSha256: sha256(await readFile(temporaryIndexPath)),
      chunks: snapshot.chunks.map((chunk) => ({
        ...chunk,
        vector: Array.from(chunk.vector),
      })),
    };
    await writeFile(temporaryMetadataPath, JSON.stringify(sidecar), 'utf8');
    await rename(temporaryIndexPath, this.filePath);
    await rename(temporaryMetadataPath, this.metadataPath);
    this.index = index;
  }

  async search(queryVector: number[], topK: number): Promise<VectorSearchHit[]> {
    if (!this.index) throw new Error('FAISS-индекс не загружен.');
    if (queryVector.length !== this.index.getDimension()) {
      throw new Error('Размерность поискового вектора не совпадает с FAISS-индексом.');
    }
    const limit = Math.max(0, Math.min(topK, this.index.ntotal()));
    if (limit === 0) return [];
    const result = this.index.search(queryVector, limit);
    return result.labels.flatMap((label, position) =>
      label < 0 ? [] : [{ index: label, score: result.distances[position] ?? 0 }],
    );
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function loadFaiss(): Promise<FaissModule> {
  try {
    const imported: unknown = await import('faiss-node');
    const candidate =
      typeof imported === 'object' && imported !== null && 'default' in imported
        ? imported.default
        : imported;
    if (!isFaissModule(candidate)) throw new Error('Модуль не экспортирует IndexFlatIP.');
    return candidate;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Компонент FAISS несовместим с этой версией Obsidian или системой. Выберите другой формат. ${detail}`,
    );
  }
}

function isFaissModule(value: unknown): value is FaissModule {
  return Boolean(
    typeof value === 'object' &&
      value !== null &&
      'IndexFlatIP' in value &&
      typeof value.IndexFlatIP === 'function',
  );
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
  return new Error(`Локальный FAISS-индекс повреждён. Перестройте его в настройках плагина. ${detail}`);
}
