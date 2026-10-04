import type { PluginSettings, VectorIndexSnapshot } from '../types';

export function validateIndexSnapshot(
  snapshot: VectorIndexSnapshot | null,
  settings: PluginSettings,
  currentScopeSignature: string,
): VectorIndexSnapshot {
  if (settings.indexNeedsRebuild) {
    throw new Error('Заметки или настройки изменились. Перестройте индекс перед RAG-запросом.');
  }
  if (!snapshot) throw new Error('Сначала перестройте локальный индекс в настройках плагина.');
  if (
    snapshot.scopeSignature !== currentScopeSignature ||
    snapshot.chunkingStrategy !== settings.chunkingStrategy ||
    snapshot.structureChunkingUnit !== settings.structureChunkingUnit ||
    snapshot.fixedChunkSize !== settings.fixedChunkSize
  ) {
    throw new Error('Настройки индекса изменились. Перестройте индекс перед запросом.');
  }
  return snapshot;
}
