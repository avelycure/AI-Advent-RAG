import type { IndexedChunk, SearchResult } from '../types';

export function searchVectors(
  chunks: readonly IndexedChunk[],
  queryVector: readonly number[],
  topK: number,
  minimumScore = 0.15,
): SearchResult[] {
  if (queryVector.length === 0 || topK <= 0) return [];
  const normalizedQuery = normalizeVector(queryVector);
  if (!normalizedQuery) return [];
  const best: Array<{ chunk: IndexedChunk; score: number; originalIndex: number }> = [];
  chunks.forEach((chunk, originalIndex) => {
    if (chunk.vector.length !== normalizedQuery.length) {
      throw new Error(
        `Vector dimension mismatch for ${chunk.metadata.chunk_id}. Rebuild the index.`,
      );
    }
    if (!isFiniteVector(chunk.vector)) return;
    const score = dot(normalizedQuery, chunk.vector);
    if (!Number.isFinite(score) || score < minimumScore) return;
    const insertionIndex = best.findIndex(
      (candidate) => score > candidate.score || (score === candidate.score && originalIndex < candidate.originalIndex),
    );
    if (insertionIndex === -1) best.push({ chunk, score, originalIndex });
    else best.splice(insertionIndex, 0, { chunk, score, originalIndex });
    if (best.length > topK) best.pop();
  });
  return best.map((result, index) => ({
    chunk: result.chunk,
    score: result.score,
    sourceId: `S${index + 1}`,
  }));
}

export function normalizeVector(vector: ArrayLike<number>): Float32Array | null {
  let squaredMagnitude = 0;
  for (let index = 0; index < vector.length; index += 1) {
    const value = vector[index];
    if (value === undefined || !Number.isFinite(value)) return null;
    squaredMagnitude += value * value;
  }
  const magnitude = Math.sqrt(squaredMagnitude);
  if (magnitude === 0) return null;
  const normalized = new Float32Array(vector.length);
  for (let index = 0; index < vector.length; index += 1) {
    normalized[index] = (vector[index] ?? 0) / magnitude;
  }
  return normalized;
}

function dot(left: ArrayLike<number>, right: ArrayLike<number>): number {
  let value = 0;
  for (let index = 0; index < left.length; index += 1) {
    value += (left[index] ?? 0) * (right[index] ?? 0);
  }
  return value;
}

function isFiniteVector(vector: ArrayLike<number>): boolean {
  for (let index = 0; index < vector.length; index += 1) {
    if (!Number.isFinite(vector[index])) return false;
  }
  return true;
}
