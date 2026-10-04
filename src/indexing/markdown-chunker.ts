import {
  DEFAULT_FIXED_CHUNK_SIZE,
  type ChunkingStrategy,
  type SourceDocument,
  type StructureChunkingUnit,
  type TextChunk,
} from '../types';

export const DEFAULT_MAX_CHARS = DEFAULT_FIXED_CHUNK_SIZE;
export const DEFAULT_OVERLAP_CHARS = 400;

interface Section {
  heading: string | null;
  line_start: number;
  lines: string[];
}

interface TextPiece {
  text: string;
  charOffset: number;
  lineOffset: number;
  lineCount: number;
}

export interface ChunkOptions {
  maxChars?: number;
  overlapChars?: number;
  structureUnit?: StructureChunkingUnit;
}

export function chunkDocument(
  document: SourceDocument,
  strategy: ChunkingStrategy,
  options: ChunkOptions = {},
): TextChunk[] {
  if (strategy === 'structure-aware') {
    return chunkByStructure(document, options.structureUnit ?? 'section');
  }
  const { maxChars, overlapChars } = validateOptions(options);
  return chunkFixedSize(document, maxChars, overlapChars);
}

export function chunkMarkdown(document: SourceDocument, options: ChunkOptions = {}): TextChunk[] {
  return chunkDocument(document, 'structure-aware', options);
}

function chunkFixedSize(
  document: SourceDocument,
  maxChars: number,
  overlapChars: number,
): TextChunk[] {
  const content = normalizeContent(document.content);
  if (!content.trim()) return [];
  return createChunks(
    document,
    'fixed-size',
    null,
    1,
    splitFixed(content, maxChars, overlapChars),
    0,
  );
}

function chunkByStructure(
  document: SourceDocument,
  unit: StructureChunkingUnit,
): TextChunk[] {
  const content = normalizeContent(document.content);
  if (unit === 'file') {
    return createChunks(
      document,
      'structure-aware',
      null,
      1,
      wholePiece(content),
      0,
      unit,
    );
  }

  const chunks: TextChunk[] = [];
  let ordinal = 0;
  for (const section of splitIntoSections(content)) {
    const isParagraphMode = unit === 'paragraph';
    const lines = isParagraphMode && section.heading ? section.lines.slice(1) : section.lines;
    const baseLine = section.line_start + (isParagraphMode && section.heading ? 1 : 0);
    let pieces = isParagraphMode
      ? splitIntoParagraphs(lines.join('\n'))
      : wholePiece(lines.join('\n'));
    let chunkBaseLine = baseLine;

    // Preserve a heading-only section instead of silently dropping searchable content.
    if (pieces.length === 0 && isParagraphMode && section.heading && section.lines[0]) {
      pieces = wholePiece(section.lines[0]);
      chunkBaseLine = section.line_start;
    }
    if (pieces.length === 0) continue;

    const sectionChunks = createChunks(
      document,
      'structure-aware',
      section.heading,
      chunkBaseLine,
      pieces,
      ordinal,
      unit,
    );
    chunks.push(...sectionChunks);
    ordinal += sectionChunks.length;
  }
  return chunks;
}

function createChunks(
  document: SourceDocument,
  strategy: ChunkingStrategy,
  section: string | null,
  baseLine: number,
  pieces: readonly TextPiece[],
  firstOrdinal: number,
  structureUnit?: StructureChunkingUnit,
): TextChunk[] {
  return pieces.map((piece, index) => {
    const ordinal = firstOrdinal + index;
    const contentHash = stableHash(piece.text);
    const line_start = baseLine + piece.lineOffset;
    const line_end = line_start + piece.lineCount - 1;
    const chunk_id = stableHash(
      [
        structureUnit ? `${strategy}:${structureUnit}` : strategy,
        document.path,
        section ?? '',
        String(line_start),
        String(piece.charOffset),
        contentHash,
      ].join('|'),
    );
    return {
      ordinal,
      text: piece.text,
      contentHash,
      metadata: {
        source: document.path,
        title: document.title ?? titleFromPath(document.path),
        section,
        chunk_id,
        line_start,
        line_end,
        file_mtime: document.mtime,
      },
    };
  });
}

function wholePiece(text: string): TextPiece[] {
  const leading = text.length - text.trimStart().length;
  const piece = text.trim();
  if (!piece) return [];
  return [
    {
      text: piece,
      charOffset: leading,
      lineOffset: countNewlines(text.slice(0, leading)),
      lineCount: countLines(piece),
    },
  ];
}

function splitIntoParagraphs(text: string): TextPiece[] {
  const lines = text.split('\n');
  const lineOffsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineOffsets.push(offset);
    offset += line.length + 1;
  }

  const pieces: TextPiece[] = [];
  let paragraphStart: number | null = null;
  let inFence = false;
  let fenceMarker = '';

  const flush = (endExclusive: number): void => {
    if (paragraphStart === null) return;
    const raw = lines.slice(paragraphStart, endExclusive).join('\n');
    const leading = raw.length - raw.trimStart().length;
    const piece = raw.trim();
    if (piece) {
      pieces.push({
        text: piece,
        charOffset: (lineOffsets[paragraphStart] ?? 0) + leading,
        lineOffset: paragraphStart + countNewlines(raw.slice(0, leading)),
        lineCount: countLines(piece),
      });
    }
    paragraphStart = null;
  };

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!inFence && !trimmed) {
      flush(index);
      return;
    }
    paragraphStart ??= index;

    const openingFence = !inFence ? /^(`{3,}|~{3,})/.exec(trimmed)?.[1] : undefined;
    if (openingFence) {
      inFence = true;
      fenceMarker = openingFence;
      return;
    }
    if (!inFence) return;
    const closingFence = /^(`{3,}|~{3,})[ \t]*$/.exec(trimmed)?.[1];
    if (
      closingFence &&
      closingFence[0] === fenceMarker[0] &&
      closingFence.length >= fenceMarker.length
    ) {
      inFence = false;
      fenceMarker = '';
    }
  });
  flush(lines.length);
  return pieces;
}

function validateOptions(options: ChunkOptions): { maxChars: number; overlapChars: number } {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const overlapChars = options.overlapChars ?? DEFAULT_OVERLAP_CHARS;
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new Error('Chunk size must be a positive integer.');
  }
  if (!Number.isInteger(overlapChars) || overlapChars < 0 || overlapChars >= maxChars) {
    throw new Error('Chunk overlap must be a non-negative integer smaller than the chunk size.');
  }
  return { maxChars, overlapChars };
}

function splitIntoSections(content: string): Section[] {
  const lines = content.split('\n');
  const sections: Section[] = [];
  const headingStack: string[] = [];
  let current: Section = { heading: null, line_start: 1, lines: [] };
  let inFence = false;
  let fenceMarker = '';
  let inFrontmatter = lines[0]?.trim() === '---';

  const flush = (): void => {
    if (current.lines.some((line) => line.trim())) sections.push(current);
  };

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (index > 0 && inFrontmatter && trimmed === '---') {
      inFrontmatter = false;
      current.lines.push(line);
      return;
    }
    const openingFence = /^(`{3,}|~{3,})/.exec(trimmed)?.[1];
    if (!inFence && openingFence) {
      inFence = true;
      fenceMarker = openingFence;
      current.lines.push(line);
      return;
    }
    if (inFence) {
      const closingFence = /^(`{3,}|~{3,})[ \t]*$/.exec(trimmed)?.[1];
      if (
        closingFence &&
        closingFence[0] === fenceMarker[0] &&
        closingFence.length >= fenceMarker.length
      ) {
        inFence = false;
        fenceMarker = '';
      }
      current.lines.push(line);
      return;
    }

    const match = !inFence && !inFrontmatter
      ? /^ {0,3}(#{1,6})\s+(.+?)\s*$/.exec(line)
      : null;
    if (!match) {
      current.lines.push(line);
      return;
    }

    flush();
    const level = match[1]?.length ?? 1;
    const title = match[2]?.replace(/\s+#+$/, '').trim() ?? '';
    headingStack.splice(level - 1);
    headingStack[level - 1] = title;
    current = {
      heading: headingStack.filter(Boolean).join(' › '),
      line_start: index + 1,
      lines: [line],
    };
  });
  flush();
  return sections;
}

function splitFixed(text: string, maxChars: number, overlapChars: number): TextPiece[] {
  const boundaries = codePointBoundaries(text);
  const characterCount = boundaries.length - 1;
  if (characterCount <= maxChars) {
    const leading = text.length - text.trimStart().length;
    const piece = text.trim();
    return [
      {
        text: piece,
        charOffset: leading,
        lineOffset: countNewlines(text.slice(0, leading)),
        lineCount: countLines(piece),
      },
    ];
  }

  const pieces: TextPiece[] = [];
  let startCharacter = 0;
  while (startCharacter < characterCount) {
    const endCharacter = Math.min(characterCount, startCharacter + maxChars);
    const start = boundaries[startCharacter] ?? 0;
    const end = boundaries[endCharacter] ?? text.length;
    const raw = text.slice(start, end);
    const leading = raw.length - raw.trimStart().length;
    const piece = raw.trim();
    const actualStart = start + leading;
    if (piece) {
      pieces.push({
        text: piece,
        charOffset: actualStart,
        lineOffset: countNewlines(text.slice(0, actualStart)),
        lineCount: countLines(piece),
      });
    }
    if (endCharacter >= characterCount) break;
    startCharacter = Math.max(startCharacter + 1, endCharacter - overlapChars);
  }
  return pieces;
}

function codePointBoundaries(text: string): number[] {
  const boundaries = [0];
  let offset = 0;
  for (const character of text) {
    offset += character.length;
    boundaries.push(offset);
  }
  return boundaries;
}

export function countCharacters(text: string): number {
  let count = 0;
  for (const _character of text) count += 1;
  return count;
}

function normalizeContent(content: string): string {
  return content.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

function titleFromPath(path: string): string {
  const filename = path.replaceAll('\\', '/').split('/').at(-1) ?? path;
  return filename.replace(/\.md$/i, '');
}

function countLines(value: string): number {
  return value ? countNewlines(value) + 1 : 0;
}

function countNewlines(value: string): number {
  let count = 0;
  for (const character of value) if (character === '\n') count += 1;
  return count;
}

export function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
