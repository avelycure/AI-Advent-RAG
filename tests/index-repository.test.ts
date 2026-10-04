import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BinaryIndexRepository } from '../src/indexing/index-repository';
import { FaissIndexRepository } from '../src/indexing/faiss-index-repository';
import { JsonIndexRepository } from '../src/indexing/json-index-repository';
import { SqliteIndexRepository } from '../src/indexing/sqlite-index-repository';
import type { IndexRepository, VectorIndexSnapshot } from '../src/types';
import { indexSnapshot, indexedChunk } from './test-fixtures';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('binary index repository', () => {
  it('atomically round-trips metadata, text, and float vectors', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ai-advent-rag-'));
    temporaryDirectories.push(directory);
    const repository = new BinaryIndexRepository(join(directory, 'index.bin'));
    const snapshot: VectorIndexSnapshot = indexSnapshot(
      [
        indexedChunk('id', [0.25, -0.5], {
          text: 'Текст',
          contentHash: 'hash',
          metadata: {
            source: 'Заметка.md',
            title: 'Заметка',
            section: 'Раздел',
            chunk_id: 'id',
            line_start: 1,
            line_end: 2,
            file_mtime: 1,
          },
        }),
      ],
      {
      builtAt: 123,
      },
    );

    await repository.save(snapshot);
    const loaded = await repository.load();
    expect(loaded).toMatchObject({
      embeddingFingerprint: 'digest',
      scopeSignature: 'all:',
      fixedChunkSize: 3200,
    });
    expect(loaded?.chunks[0]?.vector).toBeInstanceOf(Float32Array);
    expect(loaded?.chunks[0]?.vector[0]).toBeCloseTo(0.25);
    expect(loaded?.chunks[0]?.text).toBe('Текст');
  });

  it('rejects configured fixed chunk sizes outside the public range', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ai-advent-rag-'));
    temporaryDirectories.push(directory);
    const repository = new BinaryIndexRepository(join(directory, 'index.bin'));

    await expect(
      repository.save(indexSnapshot([indexedChunk('small')], { fixedChunkSize: 255 })),
    ).rejects.toThrow(/некорректный снимок индекса/i);
    await expect(
      repository.save(indexSnapshot([indexedChunk('large')], { fixedChunkSize: 20_001 })),
    ).rejects.toThrow(/некорректный снимок индекса/i);
  });

  it('rejects an unknown structural chunking unit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ai-advent-rag-'));
    temporaryDirectories.push(directory);
    const repository = new BinaryIndexRepository(join(directory, 'index.bin'));

    await expect(
      repository.save(
        indexSnapshot([indexedChunk('invalid-unit')], {
          structureChunkingUnit: 'unknown' as never,
        }),
      ),
    ).rejects.toThrow(/некорректный снимок индекса/i);
  });
});

describe.each([
  ['binary', (path: string): IndexRepository => new BinaryIndexRepository(`${path}.bin`)],
  ['JSON', (path: string): IndexRepository => new JsonIndexRepository(`${path}.json`)],
  ['SQLite', (path: string): IndexRepository => new SqliteIndexRepository(`${path}.sqlite`)],
  ['FAISS', (path: string): IndexRepository => new FaissIndexRepository(`${path}.faiss`)],
] as const)('%s index repository', (_name, createRepository) => {
  it('round-trips Unicode chunks and Float32 vectors', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ai-advent-rag-formats-'));
    temporaryDirectories.push(directory);
    const repository = createRepository(join(directory, 'index'));
    const snapshot = indexSnapshot([
      indexedChunk('первый-😀', [1, 0], {
        text: 'Русский текст\nсо второй строкой 😀',
        metadata: {
          source: 'Папка/Заметка 😀.md',
          title: 'Заметка 😀',
          section: 'Раздел',
          chunk_id: 'первый-😀',
          line_start: 2,
          line_end: 3,
          file_mtime: 42,
        },
      }),
      indexedChunk('second', [0, 1]),
    ]);

    expect(await repository.load()).toBeNull();
    await repository.save(snapshot);
    const loaded = await createRepository(join(directory, 'index')).load();

    expect(loaded?.chunks).toHaveLength(2);
    expect(loaded?.chunks[0]?.text).toBe('Русский текст\nсо второй строкой 😀');
    expect(loaded?.chunks[0]?.metadata.source).toBe('Папка/Заметка 😀.md');
    expect(loaded?.chunks[0]?.vector).toBeInstanceOf(Float32Array);
    expect(Array.from(loaded?.chunks[1]?.vector ?? [])).toEqual([0, 1]);
  });
});

describe('FAISS vector search', () => {
  it('uses inner product over normalized vectors and preserves chunk order IDs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ai-advent-rag-faiss-'));
    temporaryDirectories.push(directory);
    const repository = new FaissIndexRepository(join(directory, 'index.faiss'));
    await repository.save(
      indexSnapshot([
        indexedChunk('horizontal', [1, 0]),
        indexedChunk('vertical', [0, 1]),
      ]),
    );

    await repository.load();
    const hits = await repository.search([0.9, 0.1], 2);
    expect(hits.map((hit) => hit.index)).toEqual([0, 1]);
    expect(hits[0]?.score).toBeCloseTo(0.9);
  });

  it('rejects a torn FAISS and metadata pair even when count and dimension match', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ai-advent-rag-faiss-pair-'));
    temporaryDirectories.push(directory);
    const filePath = join(directory, 'index.faiss');
    const repository = new FaissIndexRepository(filePath);
    await repository.save(indexSnapshot([indexedChunk('old', [1, 0])]));
    const oldMetadata = await readFile(`${filePath}.json`);

    await repository.save(indexSnapshot([indexedChunk('new', [0, 1])]));
    await writeFile(`${filePath}.json`, oldMetadata);

    await expect(new FaissIndexRepository(filePath).load()).rejects.toThrow(
      /контрольной сумме/i,
    );
  });
});
