import { mkdir, open, rename, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  INDEX_SCHEMA_VERSION,
  MAX_FIXED_CHUNK_SIZE,
  MIN_FIXED_CHUNK_SIZE,
  type IndexRepository,
  type IndexedChunk,
  type VectorIndexSnapshot,
} from '../types';

export type SerializedChunk = Omit<IndexedChunk, 'vector'>;

export interface SerializedSnapshot extends Omit<VectorIndexSnapshot, 'chunks'> {
  chunks: SerializedChunk[];
}

const HEADER_SIZE = 4;
const MAX_METADATA_BYTES = 256 * 1024 * 1024;

export class BinaryIndexRepository implements IndexRepository {
  readonly format = 'binary' as const;
  constructor(private readonly filePath: string) {}

  async load(): Promise<VectorIndexSnapshot | null> {
    try {
      const handle = await open(this.filePath, 'r');
      try {
        const fileSize = (await handle.stat()).size;
        if (fileSize < HEADER_SIZE) throw new Error('Заголовок индекса отсутствует.');
        const header = Buffer.allocUnsafe(HEADER_SIZE);
        await readFully(handle, header, 0);
        const metadataLength = header.readUInt32LE(0);
        if (metadataLength > MAX_METADATA_BYTES) throw new Error('Метаданные индекса слишком велики.');
        const vectorsOffset = HEADER_SIZE + metadataLength;
        if (vectorsOffset > fileSize) throw new Error('Метаданные индекса обрезаны.');
        const metadataBytes = Buffer.allocUnsafe(metadataLength);
        await readFully(handle, metadataBytes, HEADER_SIZE);
        const metadata = JSON.parse(metadataBytes.toString('utf8')) as SerializedSnapshot;
        validateMetadata(metadata);
        const expectedBytes =
          metadata.chunks.length * metadata.vectorDimension * Float32Array.BYTES_PER_ELEMENT;
        if (fileSize - vectorsOffset !== expectedBytes) {
          throw new Error('Данные векторов в индексе обрезаны.');
        }

        const vectorData = new Float32Array(metadata.chunks.length * metadata.vectorDimension);
        await readFully(handle, Buffer.from(vectorData.buffer), vectorsOffset);
        const chunks = metadata.chunks.map((chunk, index) => ({
          ...chunk,
          vector: vectorData.subarray(
            index * metadata.vectorDimension,
            (index + 1) * metadata.vectorDimension,
          ),
        }));
        return { ...metadata, chunks };
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw new Error(
        `Локальный RAG-индекс повреждён. Перестройте его в настройках плагина. ${error instanceof Error ? error.message : ''}`,
      );
    }
  }

  async save(snapshot: VectorIndexSnapshot): Promise<void> {
    validateSnapshot(snapshot);
    await mkdir(dirname(this.filePath), { recursive: true });
    const metadata: SerializedSnapshot = {
      ...snapshot,
      chunks: snapshot.chunks.map(({ vector: _vector, ...chunk }) => chunk),
    };
    const metadataBytes = Buffer.from(JSON.stringify(metadata), 'utf8');
    const header = Buffer.allocUnsafe(HEADER_SIZE);
    header.writeUInt32LE(metadataBytes.byteLength, 0);
    const temporaryPath = `${this.filePath}.tmp`;
    const handle = await open(temporaryPath, 'w');
    try {
      let position = 0;
      position = await writeFully(handle, header, position);
      position = await writeFully(handle, metadataBytes, position);
      for (const chunk of snapshot.chunks) {
        const vectorBytes = Buffer.allocUnsafe(
          snapshot.vectorDimension * Float32Array.BYTES_PER_ELEMENT,
        );
        for (let index = 0; index < chunk.vector.length; index += 1) {
          vectorBytes.writeFloatLE(chunk.vector[index] ?? 0, index * Float32Array.BYTES_PER_ELEMENT);
        }
        position = await writeFully(handle, vectorBytes, position);
      }
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, this.filePath);
  }
}

export function validateMetadata(snapshot: SerializedSnapshot): void {
  if (
    !snapshot ||
    !Array.isArray(snapshot.chunks) ||
    !Number.isInteger(snapshot.vectorDimension) ||
    snapshot.vectorDimension < 0 ||
    !snapshot.embeddingFingerprint ||
    (snapshot.schemaVersion === INDEX_SCHEMA_VERSION &&
      ((snapshot.chunkingStrategy !== 'fixed-size' &&
        snapshot.chunkingStrategy !== 'structure-aware') ||
        !isStructureChunkingUnit(snapshot.structureChunkingUnit) ||
        !Number.isInteger(snapshot.fixedChunkSize) ||
        snapshot.fixedChunkSize < MIN_FIXED_CHUNK_SIZE ||
        snapshot.fixedChunkSize > MAX_FIXED_CHUNK_SIZE ||
        !snapshot.chunkingComparison ||
        snapshot.chunkingComparison.structureChunkingUnit !== snapshot.structureChunkingUnit ||
        snapshot.chunks.some((chunk) => !isValidChunkMetadata(chunk))))
  ) {
    throw new Error('Некорректный снимок индекса.');
  }
}

function isStructureChunkingUnit(value: unknown): boolean {
  return value === 'paragraph' || value === 'section' || value === 'file';
}

function isValidChunkMetadata(chunk: SerializedChunk): boolean {
  const metadata = chunk.metadata;
  return Boolean(
    metadata &&
      typeof metadata.source === 'string' &&
      typeof metadata.title === 'string' &&
      typeof metadata.chunk_id === 'string' &&
      Number.isInteger(metadata.line_start) &&
      Number.isInteger(metadata.line_end) &&
      typeof metadata.file_mtime === 'number',
  );
}

export function validateSnapshot(snapshot: VectorIndexSnapshot): void {
  validateMetadata({
    ...snapshot,
    chunks: snapshot.chunks.map(({ vector: _vector, ...chunk }) => chunk),
  });
  if (
    snapshot.chunks.some(
      (chunk) =>
        chunk.vector.length !== snapshot.vectorDimension || !isFiniteVector(chunk.vector),
    )
  ) {
    throw new Error('Снимок индекса содержит некорректные векторы.');
  }
}

export function serializeSnapshot(snapshot: VectorIndexSnapshot): SerializedSnapshot {
  validateSnapshot(snapshot);
  return {
    ...snapshot,
    chunks: snapshot.chunks.map(({ vector: _vector, ...chunk }) => chunk),
  };
}

export function vectorToBuffer(vector: ArrayLike<number>): Buffer {
  const buffer = Buffer.allocUnsafe(vector.length * Float32Array.BYTES_PER_ELEMENT);
  for (let index = 0; index < vector.length; index += 1) {
    buffer.writeFloatLE(vector[index] ?? 0, index * Float32Array.BYTES_PER_ELEMENT);
  }
  return buffer;
}

export function bufferToVector(buffer: Uint8Array, dimension: number): Float32Array {
  if (buffer.byteLength !== dimension * Float32Array.BYTES_PER_ELEMENT) {
    throw new Error('Вектор имеет некорректную размерность.');
  }
  const result = new Float32Array(dimension);
  const bytes = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  for (let index = 0; index < dimension; index += 1) {
    result[index] = bytes.readFloatLE(index * Float32Array.BYTES_PER_ELEMENT);
  }
  return result;
}

async function writeFully(handle: FileHandle, buffer: Buffer, startPosition: number): Promise<number> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(
      buffer,
      offset,
      buffer.length - offset,
      startPosition + offset,
    );
    if (bytesWritten === 0) throw new Error('Не удалось записать локальный индекс.');
    offset += bytesWritten;
  }
  return startPosition + buffer.length;
}

async function readFully(handle: FileHandle, buffer: Buffer, startPosition: number): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      startPosition + offset,
    );
    if (bytesRead === 0) throw new Error('Данные индекса обрезаны.');
    offset += bytesRead;
  }
}

function isFiniteVector(vector: ArrayLike<number>): boolean {
  for (let index = 0; index < vector.length; index += 1) {
    if (!Number.isFinite(vector[index])) return false;
  }
  return true;
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  );
}
