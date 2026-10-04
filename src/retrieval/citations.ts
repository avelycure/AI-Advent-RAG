import type { SearchResult } from '../types';

export interface CitationPart {
  text: string;
  source?: SearchResult;
}

export function citationParts(answer: string, sources: readonly SearchResult[]): CitationPart[] {
  const byId = new Map(sources.map((source) => [source.sourceId, source]));
  const parts: CitationPart[] = [];
  const pattern = /\[(S\d+)]/g;
  let cursor = 0;

  for (const match of answer.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push({ text: answer.slice(cursor, index) });
    const id = match[1] ?? '';
    const source = byId.get(id);
    parts.push(source ? { text: match[0], source } : { text: match[0] });
    cursor = index + match[0].length;
  }
  if (cursor < answer.length) parts.push({ text: answer.slice(cursor) });
  return parts;
}

export function sourceLinkText(source: SearchResult): string {
  const heading = source.chunk.metadata.section?.split(' › ').at(-1);
  return heading
    ? `${source.chunk.metadata.source}#${heading}`
    : source.chunk.metadata.source;
}
