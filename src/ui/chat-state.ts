import { cloneTaskMemory, EMPTY_TASK_MEMORY, sanitizeTaskMemory } from '../rag/task-memory';
import type {
  ChatTurn,
  GroundedCitation,
  GroundingStatus,
  RetrievalDiagnostics,
  SearchResult,
  TaskMemory,
} from '../types';

export const CHAT_STATE_VERSION = 1;
export const MAX_PERSISTED_CHAT_ENTRIES = 80;

export type ChatMode = 'direct' | 'rag-basic' | 'rag-enhanced';

export interface ChatEntry extends ChatTurn {
  sources?: SearchResult[];
  citations?: GroundedCitation[];
  groundingStatus?: GroundingStatus;
  usedRag?: boolean;
  usedRetrievalEnhancements?: boolean;
  modelCalled?: boolean;
  retrieval?: RetrievalDiagnostics;
}

export interface ChatState {
  version: number;
  entries: ChatEntry[];
  taskMemories: Record<ChatMode, TaskMemory>;
  updatedAt: number;
}

export function emptyChatState(): ChatState {
  return {
    version: CHAT_STATE_VERSION,
    entries: [],
    taskMemories: {
      direct: cloneTaskMemory(EMPTY_TASK_MEMORY),
      'rag-basic': cloneTaskMemory(EMPTY_TASK_MEMORY),
      'rag-enhanced': cloneTaskMemory(EMPTY_TASK_MEMORY),
    },
    updatedAt: Date.now(),
  };
}

export function chatMode(useRag: boolean, useRetrievalEnhancements: boolean): ChatMode {
  if (!useRag) return 'direct';
  return useRetrievalEnhancements ? 'rag-enhanced' : 'rag-basic';
}

export function sanitizeChatState(value: unknown): ChatState {
  const fallback = emptyChatState();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  const record = value as Record<string, unknown>;
  const memories = record.taskMemories && typeof record.taskMemories === 'object' &&
    !Array.isArray(record.taskMemories)
    ? record.taskMemories as Record<string, unknown>
    : {};
  return {
    version: CHAT_STATE_VERSION,
    entries: sanitizeEntries(record.entries),
    taskMemories: {
      direct: sanitizeTaskMemory(memories.direct),
      'rag-basic': sanitizeTaskMemory(memories['rag-basic']),
      'rag-enhanced': sanitizeTaskMemory(memories['rag-enhanced']),
    },
    updatedAt: finiteNumber(record.updatedAt) ?? Date.now(),
  };
}

export function compactChatState(state: ChatState): ChatState {
  return sanitizeChatState({
    ...state,
    version: CHAT_STATE_VERSION,
    entries: state.entries.slice(-MAX_PERSISTED_CHAT_ENTRIES).map(compactEntry),
    updatedAt: Date.now(),
  });
}

function compactEntry(entry: ChatEntry): ChatEntry {
  return {
    role: entry.role,
    content: entry.content,
    usedRag: entry.usedRag,
    usedRetrievalEnhancements: entry.usedRetrievalEnhancements,
    modelCalled: entry.modelCalled,
    groundingStatus: entry.groundingStatus,
    sources: entry.sources?.map(compactSource),
    citations: entry.citations?.map((citation) => ({ ...citation })),
    retrieval: entry.retrieval ? { ...entry.retrieval } : undefined,
  };
}

function compactSource(source: SearchResult): SearchResult {
  return {
    sourceId: source.sourceId,
    score: source.score,
    contextTruncated: source.contextTruncated,
    chunk: {
      ordinal: source.chunk.ordinal,
      text: '',
      contentHash: source.chunk.contentHash,
      metadata: { ...source.chunk.metadata },
      vector: [],
    },
  };
}

function sanitizeEntries(value: unknown): ChatEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: ChatEntry[] = [];
  for (const item of value.slice(-MAX_PERSISTED_CHAT_ENTRIES)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const role = record.role === 'user' || record.role === 'assistant' ? record.role : null;
    const content = boundedString(record.content, 50_000);
    if (!role || !content) continue;
    entries.push({
      role,
      content,
      usedRag: booleanOrUndefined(record.usedRag),
      usedRetrievalEnhancements: booleanOrUndefined(record.usedRetrievalEnhancements),
      modelCalled: booleanOrUndefined(record.modelCalled),
      groundingStatus: groundingStatus(record.groundingStatus),
      sources: sanitizeSources(record.sources),
      citations: sanitizeCitations(record.citations),
      retrieval: sanitizeDiagnostics(record.retrieval),
    });
  }
  return entries;
}

function sanitizeSources(value: unknown): SearchResult[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const sources: SearchResult[] = [];
  for (const item of value.slice(0, 20)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const chunk = record.chunk;
    if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) continue;
    const chunkRecord = chunk as Record<string, unknown>;
    const metadata = chunkRecord.metadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) continue;
    const metadataRecord = metadata as Record<string, unknown>;
    const sourceId = boundedString(record.sourceId, 50);
    const source = boundedString(metadataRecord.source, 2_000);
    const title = boundedString(metadataRecord.title, 1_000);
    const chunkId = boundedString(metadataRecord.chunk_id, 500);
    const score = finiteNumber(record.score);
    if (!sourceId || !source || !title || !chunkId || score === null) continue;
    sources.push({
      sourceId,
      score,
      contextTruncated: booleanOrUndefined(record.contextTruncated),
      chunk: {
        ordinal: finiteNumber(chunkRecord.ordinal) ?? 0,
        text: '',
        contentHash: boundedString(chunkRecord.contentHash, 500) ?? '',
        metadata: {
          source,
          title,
          section: metadataRecord.section === null
            ? null
            : boundedString(metadataRecord.section, 2_000),
          chunk_id: chunkId,
          line_start: finiteNumber(metadataRecord.line_start) ?? 1,
          line_end: finiteNumber(metadataRecord.line_end) ?? 1,
          file_mtime: finiteNumber(metadataRecord.file_mtime) ?? 0,
        },
        vector: [],
      },
    });
  }
  return sources;
}

function sanitizeCitations(value: unknown): GroundedCitation[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const citations: GroundedCitation[] = [];
  for (const item of value.slice(0, 20)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const sourceId = boundedString(record.sourceId, 50);
    const source = boundedString(record.source, 2_000);
    const chunkId = boundedString(record.chunkId, 500);
    const quote = boundedString(record.quote, 2_000);
    if (!sourceId || !source || !chunkId || !quote) continue;
    citations.push({
      sourceId,
      source,
      section: record.section === null ? null : boundedString(record.section, 2_000),
      chunkId,
      quote,
    });
  }
  return citations;
}

function sanitizeDiagnostics(value: unknown): RetrievalDiagnostics | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const originalQuery = boundedString(record.originalQuery, 4_000);
  const searchQuery = boundedString(record.searchQuery, 4_000);
  if (!originalQuery || !searchQuery) return undefined;
  return {
    originalQuery,
    searchQuery,
    queryRewritten: record.queryRewritten === true,
    rewriteFailed: record.rewriteFailed === true,
    candidateCount: finiteNumber(record.candidateCount) ?? 0,
    resultCount: finiteNumber(record.resultCount) ?? 0,
    candidateTopK: finiteNumber(record.candidateTopK) ?? 0,
    finalTopK: finiteNumber(record.finalTopK) ?? 0,
    similarityThreshold: record.similarityThreshold === null
      ? null
      : finiteNumber(record.similarityThreshold),
    groundingRepairAttempted: booleanOrUndefined(record.groundingRepairAttempted),
    groundingValidationFailed: booleanOrUndefined(record.groundingValidationFailed),
    taskMemoryUpdateFailed: booleanOrUndefined(record.taskMemoryUpdateFailed),
  };
}

function groundingStatus(value: unknown): GroundingStatus | undefined {
  return value === 'not-applicable' || value === 'grounded' || value === 'not-enough-context'
    ? value
    : undefined;
}

function boundedString(value: unknown, maxCharacters: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.slice(0, maxCharacters);
  return text || null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}
