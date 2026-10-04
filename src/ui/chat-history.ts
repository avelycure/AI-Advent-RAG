import type { ChatTurn } from '../types';

export interface ModeTaggedChatTurn extends ChatTurn {
  usedRag?: boolean;
  usedRetrievalEnhancements?: boolean;
}

export function historyForMode(
  entries: readonly ModeTaggedChatTurn[],
  useRag: boolean,
  useRetrievalEnhancements = false,
): ChatTurn[] {
  return entries
    .filter(
      (entry) =>
        entry.usedRag === useRag &&
        (!useRag || Boolean(entry.usedRetrievalEnhancements) === useRetrievalEnhancements),
    )
    .map(({ role, content }) => ({ role, content }));
}
