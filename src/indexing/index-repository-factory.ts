import { join } from 'node:path';
import type { IndexRepository, IndexStorageFormat } from '../types';
import { BinaryIndexRepository } from './index-repository';
import { FaissIndexRepository } from './faiss-index-repository';
import { JsonIndexRepository } from './json-index-repository';
import { SqliteIndexRepository } from './sqlite-index-repository';

export function createIndexRepository(
  directory: string,
  format: IndexStorageFormat,
): IndexRepository {
  switch (format) {
    case 'binary':
      return new BinaryIndexRepository(join(directory, 'rag-index.bin'));
    case 'json':
      return new JsonIndexRepository(join(directory, 'rag-index.json'));
    case 'sqlite':
      return new SqliteIndexRepository(join(directory, 'rag-index.sqlite'));
    case 'faiss':
      return new FaissIndexRepository(join(directory, 'rag-index.faiss'));
  }
}

export function storageFormatLabel(format: IndexStorageFormat): string {
  switch (format) {
    case 'binary':
      return 'бинарный';
    case 'json':
      return 'JSON';
    case 'sqlite':
      return 'SQLite';
    case 'faiss':
      return 'FAISS';
  }
}
