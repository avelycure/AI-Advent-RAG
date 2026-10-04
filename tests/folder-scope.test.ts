import { describe, expect, it } from 'vitest';
import { discoverFolders, isPathInScope, scopeSignature } from '../src/indexing/folder-scope';

describe('folder scope', () => {
  const paths = ['Root.md', 'Work/One.md', 'Work/Deep/Two.md', 'Workshop/Three.md', 'Личное/Идея.md'];

  it('includes every note in all mode', () => {
    expect(paths.every((path) => isPathInScope(path, { mode: 'all', folders: [] }))).toBe(true);
  });

  it('includes a selected folder and descendants only', () => {
    const included = paths.filter((path) =>
      isPathInScope(path, { mode: 'include', folders: ['/Work/'] }),
    );
    expect(included).toEqual(['Work/One.md', 'Work/Deep/Two.md']);
  });

  it('does not confuse similar folder prefixes', () => {
    expect(isPathInScope('Workshop/Three.md', { mode: 'include', folders: ['Work'] })).toBe(false);
  });

  it('excludes selected folders and descendants', () => {
    const included = paths.filter((path) =>
      isPathInScope(path, { mode: 'exclude', folders: ['Work', 'Личное'] }),
    );
    expect(included).toEqual(['Root.md', 'Workshop/Three.md']);
  });

  it('creates stable normalized signatures', () => {
    expect(scopeSignature({ mode: 'include', folders: ['B/', '/A', 'A'] })).toBe('include:A|B');
  });

  it('discovers all ancestor folders', () => {
    expect(discoverFolders(['A/B/note.md', 'A/other.md', 'Root.md'])).toEqual(['A', 'A/B']);
  });
});
