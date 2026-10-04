import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const INDEX_DIRECTORY_NAME = 'rag-indexes';

export function indexDirectoryPath(pluginDirectory: string): string {
  return join(pluginDirectory, INDEX_DIRECTORY_NAME);
}

export async function ensureIndexDirectory(pluginDirectory: string): Promise<string> {
  const directory = indexDirectoryPath(pluginDirectory);
  await mkdir(directory, { recursive: true });
  return directory;
}
