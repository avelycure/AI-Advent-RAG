import { normalizeFolderList } from '../settings/defaults';
import type { FolderMode } from '../types';

export interface FolderScope {
  mode: FolderMode;
  folders: string[];
}

export function isPathInScope(filePath: string, scope: FolderScope): boolean {
  if (scope.mode === 'all') return true;

  const normalizedPath = filePath.replaceAll('\\', '/').replace(/^\/+/, '');
  const folders = normalizeFolderList(scope.folders);
  const matches = folders.some(
    (folder) => normalizedPath.startsWith(`${folder}/`) || normalizedPath === folder,
  );

  return scope.mode === 'include' ? matches : !matches;
}

export function scopeSignature(scope: FolderScope): string {
  return `${scope.mode}:${normalizeFolderList(scope.folders).join('|')}`;
}

export function discoverFolders(paths: readonly string[]): string[] {
  const folders = new Set<string>();
  for (const path of paths) {
    const parts = path.replaceAll('\\', '/').split('/');
    parts.pop();
    for (let index = 1; index <= parts.length; index += 1) {
      folders.add(parts.slice(0, index).join('/'));
    }
  }
  return [...folders].filter(Boolean).sort((a, b) => a.localeCompare(b));
}
