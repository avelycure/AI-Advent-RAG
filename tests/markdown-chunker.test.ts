import { describe, expect, it } from 'vitest';
import { chunkDocument } from '../src/indexing/markdown-chunker';

const document = (content: string) => ({
  path: 'Проект.md',
  title: 'Проект',
  content,
  mtime: 123,
});

describe('fixed-size chunking', () => {
  it('creates deterministic overlapping windows with complete metadata', () => {
    const content = 'A'.repeat(800);
    const first = chunkDocument(document(content), 'fixed-size', {
      maxChars: 400,
      overlapChars: 100,
    });
    const second = chunkDocument(document(content), 'fixed-size', {
      maxChars: 400,
      overlapChars: 100,
    });
    expect(first).toEqual(second);
    expect(first.map((chunk) => chunk.text.length)).toEqual([400, 400, 200]);
    expect(first.map((chunk) => chunk.metadata.chunk_id)).toHaveLength(3);
    expect(new Set(first.map((chunk) => chunk.metadata.chunk_id))).toHaveLength(3);
    expect(first[0]?.metadata).toMatchObject({
      source: 'Проект.md',
      title: 'Проект',
      section: null,
      line_start: 1,
      line_end: 1,
    });
  });

  it('supports zero overlap and rejects invalid configurations', () => {
    const chunks = chunkDocument(document('A'.repeat(800)), 'fixed-size', {
      maxChars: 400,
      overlapChars: 0,
    });
    expect(chunks.map((chunk) => chunk.text.length)).toEqual([400, 400]);
    expect(() =>
      chunkDocument(document('text'), 'fixed-size', { maxChars: 400, overlapChars: 400 }),
    ).toThrow(/overlap/i);
  });

  it('does not split Unicode surrogate pairs', () => {
    const chunks = chunkDocument(document(`${'A'.repeat(399)}😀tail`), 'fixed-size', {
      maxChars: 400,
      overlapChars: 20,
    });
    expect(
      chunks.every((chunk) =>
        [...chunk.text].every((character) => {
          const code = character.charCodeAt(0);
          return character.length > 1 || code < 0xd800 || code > 0xdfff;
        }),
      ),
    ).toBe(true);
    expect(chunks.some((chunk) => chunk.text.includes('😀'))).toBe(true);
  });

  it('always advances for one-character emoji windows', () => {
    const chunks = chunkDocument(document('😀😀😀'), 'fixed-size', {
      maxChars: 1,
      overlapChars: 0,
    });
    expect(chunks.map((chunk) => chunk.text)).toEqual(['😀', '😀', '😀']);
  });
});

describe('structure-aware chunking', () => {
  it('creates chunks with heading paths and deterministic ids', () => {
    const content = '# Проект\nВведение\n## Архитектура\nВекторный индекс и [[image.png|схема]].';
    const chunks = chunkDocument(document(content), 'structure-aware');
    expect(chunks).toHaveLength(2);
    expect(chunks[1]?.metadata.section).toBe('Проект › Архитектура');
    expect(chunks[1]?.text).toContain('[[image.png|схема]]');
  });

  it('does not treat headings inside frontmatter or fenced code as sections', () => {
    const content = [
      '---',
      'description: |',
      '  # not a heading',
      '---',
      '# Real',
      '```md',
      '# code heading',
      '```',
      'Body',
    ].join('\n');
    const chunks = chunkDocument(document(content), 'structure-aware');
    expect(chunks).toHaveLength(2);
    expect(chunks.map((chunk) => chunk.metadata.section)).toEqual([null, 'Real']);
  });

  it('does not close a fence when backticks are followed by code text', () => {
    const content = ['# Real', '```md', '```not a closing fence', '# still code', '```'].join(
      '\n',
    );
    const chunks = chunkDocument(document(content), 'structure-aware');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.metadata.section).toBe('Real');
  });

  it('keeps each Markdown section as one chunk regardless of fixed-size limits', () => {
    const paragraph = 'А'.repeat(700);
    const chunks = chunkDocument(
      document(`# One\n${paragraph}\n# Two\n${paragraph}`),
      'structure-aware',
      { structureUnit: 'section' },
    );
    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.text.length > 400)).toBe(true);
    expect(chunks.map((chunk) => chunk.metadata.section)).toEqual(['One', 'Two']);
  });

  it('creates paragraph chunks, preserves section metadata, and keeps fenced code together', () => {
    const content = [
      '# One',
      'First line',
      'continues',
      '',
      'Second paragraph',
      '',
      '```js',
      'const first = 1;',
      '',
      'const second = 2;',
      '```',
      '# Two',
      'Third paragraph',
    ].join('\n');
    const chunks = chunkDocument(document(content), 'structure-aware', {
      structureUnit: 'paragraph',
    });

    expect(chunks.map((chunk) => chunk.metadata.line_start)).toEqual([2, 5, 7, 13]);
    expect(chunks.map((chunk) => chunk.metadata.section)).toEqual([
      'One',
      'One',
      'One',
      'Two',
    ]);
    expect(chunks[2]?.text).toContain('\n\n');
  });

  it('keeps a complete file in one chunk', () => {
    const content = '\n# One\nFirst\n\n# Two\nSecond';
    const chunks = chunkDocument(document(content), 'structure-aware', {
      structureUnit: 'file',
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe(content.trim());
    expect(chunks[0]?.metadata).toMatchObject({ section: null, line_start: 2, line_end: 6 });
  });

  it('creates different deterministic ids for different structural units', () => {
    const content = '# One\nOnly paragraph';
    const section = chunkDocument(document(content), 'structure-aware', {
      structureUnit: 'section',
    });
    const file = chunkDocument(document(content), 'structure-aware', { structureUnit: 'file' });

    expect(section[0]?.metadata.chunk_id).not.toBe(file[0]?.metadata.chunk_id);
  });

  it('does not create chunks for empty notes', () => {
    expect(chunkDocument(document('  \n'), 'structure-aware')).toEqual([]);
  });

  it('reports the real line for a preamble after leading blank lines', () => {
    const chunks = chunkDocument(document('\n\nIntro\n# Section\nBody'), 'structure-aware');
    expect(chunks[0]?.metadata.line_start).toBe(3);
    expect(chunks[1]?.metadata.line_start).toBe(4);
  });

  it('recognizes headings indented by up to three spaces', () => {
    const chunks = chunkDocument(
      document(' # One\nBody\n   ## Two\nNested\n    ### Code indentation\nStill nested'),
      'structure-aware',
    );
    expect(chunks.map((chunk) => chunk.metadata.section)).toEqual(['One', 'One › Two']);
    expect(chunks[1]?.text).toContain('    ### Code indentation');
  });
});
