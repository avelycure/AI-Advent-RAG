import { buildRagMessages } from './prompt';
import { searchVectors } from '../retrieval/vector-search';
import type {
  EmbeddingClient,
  LlmClient,
  LlmConfig,
  RagAnswer,
  VectorIndexSnapshot,
} from '../types';

export class RagService {
  constructor(
    private readonly embeddings: EmbeddingClient,
    private readonly llm: LlmClient,
  ) {}

  async answer(
    question: string,
    index: VectorIndexSnapshot,
    llmConfig: LlmConfig,
    topK: number,
  ): Promise<RagAnswer> {
    const normalizedQuestion = question.trim();
    if (!normalizedQuestion) throw new Error('Enter a question.');
    if (index.chunks.length === 0) throw new Error('The index is empty. Rebuild it in settings.');

    const currentFingerprint = await this.embeddings.getFingerprint();
    if (currentFingerprint !== index.embeddingFingerprint) {
      throw new Error('The local Qwen embedding model changed. Rebuild the index before searching.');
    }

    const [queryVector] = await this.embeddings.embed([normalizedQuestion]);
    if (!queryVector) throw new Error('Failed to create an embedding for the question.');
    const sources = searchVectors(index.chunks, queryVector, topK);
    if (sources.length === 0) {
      return { text: 'I could not find relevant information in the indexed notes.', sources: [] };
    }

    const text = await this.llm.generate(buildRagMessages(normalizedQuestion, sources), llmConfig);
    return { text, sources };
  }
}
