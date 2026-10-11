import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const report = (...values) => process.stdout.write(`${values.join(' ')}\n`);

// Exercise the production pipeline with synthetic notes and actual local models.
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'rag-day27-'));
try {
  const outfile = join(temporaryDirectory, 'pipeline.mjs');
  await build({
    stdin: {
      contents: `export { ConfigurableLlmClient } from './src/llm/llm-client';
export { OllamaEmbeddingClient } from './src/embeddings/ollama-embedding-client';
export { LocalStreamingTransport } from './src/infrastructure/local-streaming-transport';
export { RagService } from './src/rag/rag-service';
export { indexSnapshot, indexedChunk } from './tests/test-fixtures';`,
      resolveDir: process.cwd(),
    },
    bundle: true, platform: 'node', format: 'esm', outfile,
  });
  const { ConfigurableLlmClient, OllamaEmbeddingClient, LocalStreamingTransport, RagService, indexSnapshot, indexedChunk } =
    // The imported file was just built by esbuild in our own temporary directory.
    // eslint-disable-next-line no-unsanitized/method -- import our freshly built temporary bundle
    await import(pathToFileURL(outfile).href);
  const requests = [];
  const transport = {
    async request(request) {
      assert.equal(new URL(request.url).origin, 'http://127.0.0.1:11434');
      requests.push(new URL(request.url).pathname);
      const response = await fetch(request.url, {
        method: request.method ?? 'GET',
        headers: { 'Content-Type': 'application/json' },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: AbortSignal.timeout(300_000),
      });
      assert.ok(response.ok, `Ollama HTTP ${response.status}`);
      const text = await response.text();
      return { status: response.status, text, data: JSON.parse(text) };
    },
  };
  const config = { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.8:27b' };
  const llm = new ConfigurableLlmClient(new LocalStreamingTransport());
  await llm.testConnection(config);
  report('Local connection and generation: OK');
  const embeddings = new OllamaEmbeddingClient(transport);
  const service = new RagService(embeddings, llm);
  const options = { candidateTopK: 5, finalTopK: 3, similarityThreshold: 0 };
  const text = 'Проект «Маяк» запускается 15 ноября 2026 года. Ответственный за запуск — Анна.';
  const [vector] = await embeddings.embed([text]);
  const snapshot = indexSnapshot([indexedChunk('mayak', vector, { text })], { vectorDimension: vector.length, embeddingFingerprint: await embeddings.getFingerprint() });
  const deltas = [];
  const answer = await service.answer('Моя цель — подготовить запуск проекта «Маяк». Ответы нужны краткие. Когда запускается проект и кто отвечает за запуск?', snapshot, config,
    options, [], undefined,
    (event) => { if (event.kind === 'text') deltas.push(event.text); });
  assert.equal(answer.groundingStatus, 'not-applicable');
  assert.ok(deltas.length > 1);
  assert.equal(deltas.join('').trim(), answer.text);
  assert.match(answer.text, /15.*ноябр/);
  assert.ok(!answer.retrieval?.rewriteFailed);
  report('RAG answer:', answer.text);
  report('Streaming chunks:', deltas.length);
  report('Streaming and query rewrite without task memory: OK');
  report('Embedding endpoints (chat uses native local HTTP):', [...new Set(requests)].join(', '));
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
