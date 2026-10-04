import type { ChatTurn, LlmClient, LlmConfig, TaskMemory } from '../types';
import {
  MAX_REWRITTEN_QUERY_CHARACTERS,
  buildQueryRewriteMessages,
} from './prompt';

export interface QueryRewriteResult {
  query: string;
  rewritten: boolean;
  failed: boolean;
}

export async function rewriteSearchQuery(
  question: string,
  history: readonly ChatTurn[],
  llm: LlmClient,
  config: LlmConfig,
  taskMemory?: TaskMemory,
): Promise<QueryRewriteResult> {
  try {
    const response = await llm.generate(
      buildQueryRewriteMessages(question, history, taskMemory),
      config,
    );
    const query = normalizeRewrite(response);
    if (!query) return { query: question, rewritten: false, failed: true };
    return { query, rewritten: query !== question, failed: false };
  } catch {
    return { query: question, rewritten: false, failed: true };
  }
}

export function normalizeRewrite(value: string): string {
  const firstLine = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return '';
  const withoutPrefix = firstLine.replace(/^(?:[-*]\s+|поисковый запрос\s*:\s*)/iu, '');
  return withoutPrefix
    .replace(/^["'«„]+|["'»“]+$/gu, '')
    .trim()
    .slice(0, MAX_REWRITTEN_QUERY_CHARACTERS);
}
