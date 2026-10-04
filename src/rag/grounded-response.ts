import type { GroundedCitation, GroundingStatus, SearchResult } from '../types';

const MAX_RESPONSE_CHARACTERS = 50_000;
const MAX_QUOTE_CHARACTERS = 1_200;

interface ModelSource {
  source_id?: unknown;
  source?: unknown;
  section?: unknown;
  chunk_id?: unknown;
  quote?: unknown;
}

interface ModelResponse {
  status?: unknown;
  answer?: unknown;
  sources?: unknown;
}

export interface GroundedResponse {
  status: Exclude<GroundingStatus, 'not-applicable'>;
  answer: string;
  citations: GroundedCitation[];
}

export class GroundingValidationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Ответ модели не прошёл проверку источников: ${issues.join('; ')}`);
    this.name = 'GroundingValidationError';
  }
}

export function parseGroundedResponse(
  rawResponse: string,
  sources: readonly SearchResult[],
): GroundedResponse {
  const issues: string[] = [];
  const payload = parseJson(rawResponse, issues);
  if (!payload) throw new GroundingValidationError(issues);

  const status = payload.status;
  const answer = typeof payload.answer === 'string' ? payload.answer.trim() : '';
  if (status !== 'answered' && status !== 'not_enough_context') {
    issues.push('status должен быть answered или not_enough_context');
  }
  if (!answer) issues.push('поле answer пустое');

  if (status === 'not_enough_context') {
    if (!/не\s+знаю/iu.test(answer)) issues.push('отказ должен содержать фразу «не знаю»');
    if (!/(?:уточн|конкретиз)/iu.test(answer)) issues.push('отказ должен просить уточнить вопрос');
    if (!Array.isArray(payload.sources)) {
      issues.push('при недостаточном контексте поле sources должно быть массивом');
    } else if (payload.sources.length > 0) {
      issues.push('при недостаточном контексте список sources должен быть пустым');
    }
    if (issues.length > 0) throw new GroundingValidationError(issues);
    return { status: 'not-enough-context', answer, citations: [] };
  }

  if (!Array.isArray(payload.sources) || payload.sources.length === 0) {
    issues.push('для ответа нужен непустой список sources');
  }
  const citations = validateSources(payload.sources, sources, issues);
  const citedIds = answer.match(/\[(S\d+)\]/gu)?.map((match) => match.slice(1, -1)) ?? [];
  if (citedIds.length === 0) issues.push('ответ не содержит ссылок [S1], [S2]');
  const evidenceIds = new Set(citations.map((citation) => citation.sourceId));
  for (const sourceId of citedIds) {
    if (!evidenceIds.has(sourceId)) issues.push(`для ссылки ${sourceId} нет проверенной цитаты`);
  }
  for (const sourceId of evidenceIds) {
    if (!citedIds.includes(sourceId)) issues.push(`источник ${sourceId} не упомянут в ответе`);
  }
  if (issues.length > 0) throw new GroundingValidationError(issues);
  return { status: 'grounded', answer, citations };
}

function parseJson(rawResponse: string, issues: string[]): ModelResponse | null {
  const bounded = rawResponse.trim().slice(0, MAX_RESPONSE_CHARACTERS);
  const withoutFence = bounded
    .replace(/^```(?:json)?\s*/iu, '')
    .replace(/\s*```$/u, '')
    .trim();
  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');
  if (start < 0 || end < start) {
    issues.push('не найден JSON-объект');
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(withoutFence.slice(start, end + 1));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      issues.push('корень ответа должен быть JSON-объектом');
      return null;
    }
    return parsed;
  } catch {
    issues.push('JSON не разбирается');
    return null;
  }
}

function validateSources(
  rawSources: unknown,
  sources: readonly SearchResult[],
  issues: string[],
): GroundedCitation[] {
  if (!Array.isArray(rawSources)) return [];
  const byId = new Map(sources.map((source) => [source.sourceId, source]));
  const citations: GroundedCitation[] = [];
  const seen = new Set<string>();

  for (const [position, rawSource] of rawSources.entries()) {
    if (!rawSource || typeof rawSource !== 'object' || Array.isArray(rawSource)) {
      issues.push(`sources[${position}] должен быть объектом`);
      continue;
    }
    const modelSource = rawSource as ModelSource;
    const sourceId = typeof modelSource.source_id === 'string' ? modelSource.source_id.trim() : '';
    const source = byId.get(sourceId);
    if (!source) {
      issues.push(`неизвестный source_id ${sourceId || '(пустой)'}`);
      continue;
    }
    if (seen.has(sourceId)) {
      issues.push(`source_id ${sourceId} повторяется`);
      continue;
    }
    seen.add(sourceId);

    const metadata = source.chunk.metadata;
    if (modelSource.source !== metadata.source) issues.push(`${sourceId}: неверное поле source`);
    if ((modelSource.section ?? null) !== metadata.section) issues.push(`${sourceId}: неверное поле section`);
    if (modelSource.chunk_id !== metadata.chunk_id) issues.push(`${sourceId}: неверное поле chunk_id`);
    const quote = typeof modelSource.quote === 'string' ? normalizeWhitespace(modelSource.quote) : '';
    if (!quote) {
      issues.push(`${sourceId}: цитата пустая`);
      continue;
    }
    if (quote.length > MAX_QUOTE_CHARACTERS) {
      issues.push(`${sourceId}: цитата длиннее ${MAX_QUOTE_CHARACTERS} символов`);
      continue;
    }
    if (!normalizeWhitespace(source.chunk.text).includes(quote)) {
      issues.push(`${sourceId}: цитата не найдена в чанке`);
      continue;
    }
    citations.push({
      sourceId,
      source: metadata.source,
      section: metadata.section,
      chunkId: metadata.chunk_id,
      quote,
    });
  }
  return citations;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}
