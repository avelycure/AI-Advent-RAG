import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js/dist/sql-asm.js';
import type { IndexRepository, VectorIndexSnapshot } from '../types';
import {
  bufferToVector,
  serializeSnapshot,
  type SerializedSnapshot,
  validateMetadata,
  validateSnapshot,
  vectorToBuffer,
} from './index-repository';

type SqlValue = number | string | Uint8Array | null;

interface ChunkRow {
  ordinal: number;
  text: string;
  content_hash: string;
  source: string;
  title: string;
  section: string | null;
  chunk_id: string;
  line_start: number;
  line_end: number;
  file_mtime: number;
  vector: Uint8Array;
}

let sqlPromise: Promise<SqlJsStatic> | null = null;

export class SqliteIndexRepository implements IndexRepository {
  readonly format = 'sqlite' as const;

  constructor(private readonly filePath: string) {}

  async load(): Promise<VectorIndexSnapshot | null> {
    let bytes: Buffer;
    try {
      bytes = await readFile(this.filePath);
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }

    let database: Database | undefined;
    try {
      const SQL = await loadSql();
      database = new SQL.Database(bytes);
      const metadataResult = database.exec(
        'SELECT snapshot_json FROM index_metadata WHERE id = 1',
      )[0];
      const metadataJson = metadataResult?.values[0]?.[0];
      if (typeof metadataJson !== 'string') {
        throw new Error('Метаданные SQLite-индекса отсутствуют.');
      }
      const metadata = JSON.parse(metadataJson) as SerializedSnapshot;
      validateMetadata(metadata);
      const rows = readChunks(database);
      if (rows.length !== metadata.chunks.length) {
        throw new Error('Количество чанков в SQLite не совпадает с метаданными.');
      }
      const snapshot: VectorIndexSnapshot = {
        ...metadata,
        chunks: rows.map((row) => ({
          ordinal: row.ordinal,
          text: row.text,
          contentHash: row.content_hash,
          metadata: {
            source: row.source,
            title: row.title,
            section: row.section,
            chunk_id: row.chunk_id,
            line_start: row.line_start,
            line_end: row.line_end,
            file_mtime: row.file_mtime,
          },
          vector: bufferToVector(row.vector, metadata.vectorDimension),
        })),
      };
      validateSnapshot(snapshot);
      return snapshot;
    } catch (error) {
      throw damagedIndexError(error);
    } finally {
      database?.close();
    }
  }

  async save(snapshot: VectorIndexSnapshot): Promise<void> {
    validateSnapshot(snapshot);
    await mkdir(dirname(this.filePath), { recursive: true });
    const SQL = await loadSql();
    const database = new SQL.Database();
    try {
      database.run(`
        CREATE TABLE index_metadata (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          snapshot_json TEXT NOT NULL
        );
        CREATE TABLE chunks (
          position INTEGER PRIMARY KEY,
          ordinal INTEGER NOT NULL,
          text TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          source TEXT NOT NULL,
          title TEXT NOT NULL,
          section TEXT,
          chunk_id TEXT NOT NULL,
          line_start INTEGER NOT NULL,
          line_end INTEGER NOT NULL,
          file_mtime REAL NOT NULL,
          vector BLOB NOT NULL
        );
        CREATE INDEX chunks_source_idx ON chunks(source);
        CREATE INDEX chunks_chunk_id_idx ON chunks(chunk_id);
      `);
      database.run(
        'INSERT INTO index_metadata (id, snapshot_json) VALUES (1, ?)',
        [JSON.stringify(serializeSnapshot(snapshot))],
      );
      const insert = database.prepare(`
        INSERT INTO chunks (
          position, ordinal, text, content_hash, source, title, section, chunk_id,
          line_start, line_end, file_mtime, vector
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      try {
        snapshot.chunks.forEach((chunk, position) => {
          insert.run([
            position,
            chunk.ordinal,
            chunk.text,
            chunk.contentHash,
            chunk.metadata.source,
            chunk.metadata.title,
            chunk.metadata.section,
            chunk.metadata.chunk_id,
            chunk.metadata.line_start,
            chunk.metadata.line_end,
            chunk.metadata.file_mtime,
            vectorToBuffer(chunk.vector),
          ]);
        });
      } finally {
        insert.free();
      }
      const temporaryPath = `${this.filePath}.tmp`;
      await writeFile(temporaryPath, database.export());
      await rename(temporaryPath, this.filePath);
    } finally {
      database.close();
    }
  }
}

function readChunks(database: Database): ChunkRow[] {
  const statement = database.prepare(`
    SELECT ordinal, text, content_hash, source, title, section, chunk_id,
           line_start, line_end, file_mtime, vector
    FROM chunks ORDER BY position
  `);
  const rows: ChunkRow[] = [];
  try {
    while (statement.step()) {
      const row = statement.getAsObject() as Record<string, SqlValue>;
      if (
        typeof row.ordinal !== 'number' ||
        typeof row.text !== 'string' ||
        typeof row.content_hash !== 'string' ||
        typeof row.source !== 'string' ||
        typeof row.title !== 'string' ||
        (row.section !== null && typeof row.section !== 'string') ||
        typeof row.chunk_id !== 'string' ||
        typeof row.line_start !== 'number' ||
        typeof row.line_end !== 'number' ||
        typeof row.file_mtime !== 'number' ||
        !(row.vector instanceof Uint8Array)
      ) {
        throw new Error('SQLite содержит некорректную строку чанка.');
      }
      rows.push(row as unknown as ChunkRow);
    }
  } finally {
    statement.free();
  }
  return rows;
}

function loadSql(): Promise<SqlJsStatic> {
  sqlPromise ??= initSqlJs();
  return sqlPromise;
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
  return new Error(`Локальный SQLite-индекс повреждён. Перестройте его в настройках плагина. ${detail}`);
}
