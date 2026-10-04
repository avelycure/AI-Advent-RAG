import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  INDEX_DIRECTORY_NAME,
  ensureIndexDirectory,
  indexDirectoryPath,
} from '../src/indexing/index-paths';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('index storage directory', () => {
  it('uses a dedicated rag-indexes directory', () => {
    expect(indexDirectoryPath('/plugin')).toBe(join('/plugin', INDEX_DIRECTORY_NAME));
  });

  it('creates the dedicated directory when the plugin starts', async () => {
    const pluginDirectory = await mkdtemp(join(tmpdir(), 'ai-advent-rag-paths-'));
    temporaryDirectories.push(pluginDirectory);

    const directory = await ensureIndexDirectory(pluginDirectory);

    expect(directory).toBe(join(pluginDirectory, INDEX_DIRECTORY_NAME));
    expect((await stat(directory)).isDirectory()).toBe(true);
  });
});
