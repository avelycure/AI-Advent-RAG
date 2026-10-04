import { describe, expect, it } from 'vitest';
import { buildIndex } from '../src/indexing/index-builder';
import { EMBEDDING_MODEL, type EmbeddingClient } from '../src/types';

class FakeEmbeddings implements EmbeddingClient {
  calls: string[][] = [];

  async embed(input: string[]): Promise<number[][]> {
    this.calls.push(input);
    return input.map((text) => [text.length, 1]);
  }

  async testConnection(): Promise<void> {}

  async getFingerprint(): Promise<string> {
    return 'fake-digest';
  }
}

describe('index builder', () => {
  it('chunks, batches, and records index compatibility metadata', async () => {
    const embeddings = new FakeEmbeddings();
    const snapshot = await buildIndex(
      [
        { path: 'A.md', content: '# A\nAlpha', mtime: 1 },
        { path: 'B.md', content: '# B\nBeta', mtime: 2 },
      ],
      embeddings,
      {
        scopeSignature: 'all:',
        chunkingStrategy: 'structure-aware',
        structureChunkingUnit: 'section',
        fixedChunkSize: 3200,
        batchSize: 1,
      },
    );
    expect(embeddings.calls).toHaveLength(2);
    expect(snapshot.embeddingModel).toBe(EMBEDDING_MODEL);
    expect(snapshot.embeddingFingerprint).toBe('fake-digest');
    expect(snapshot.scopeSignature).toBe('all:');
    expect(snapshot.chunkingStrategy).toBe('structure-aware');
    expect(snapshot.structureChunkingUnit).toBe('section');
    expect(snapshot.fixedChunkSize).toBe(3200);
    expect(snapshot.chunkingComparison.documentCount).toBe(2);
    expect(snapshot.chunkingComparison.fixedSize.chunkCount).toBe(2);
    expect(snapshot.chunkingComparison.structureAware.chunkCount).toBe(2);
    expect(snapshot.vectorDimension).toBe(2);
    expect(snapshot.chunks).toHaveLength(2);
    expect(snapshot.chunks[0]?.vector).toBeInstanceOf(Float32Array);
  });

  it('compares both strategies but embeds only the selected strategy', async () => {
    const embeddings = new FakeEmbeddings();
    const snapshot = await buildIndex(
      [
        {
          path: 'Comparison.md',
          content: `# One\n${'A'.repeat(700)}\n# Two\n${'B'.repeat(700)}`,
          mtime: 1,
        },
      ],
      embeddings,
      {
        scopeSignature: 'all:',
        chunkingStrategy: 'fixed-size',
        structureChunkingUnit: 'section',
        fixedChunkSize: 3200,
      },
    );

    expect(snapshot.chunks).toHaveLength(1);
    expect(embeddings.calls.flat()).toHaveLength(1);
    expect(snapshot.chunkingComparison.fixedSize.chunkCount).toBe(1);
    expect(snapshot.chunkingComparison.structureAware.chunkCount).toBe(2);
  });

  it('uses the configured size for fixed chunks and their comparison metrics', async () => {
    const embeddings = new FakeEmbeddings();
    const content = Array.from({ length: 900 }, (_, index) =>
      String.fromCodePoint(0x1000 + index),
    ).join('');
    const snapshot = await buildIndex(
      [{ path: 'Sized.md', content, mtime: 1 }],
      embeddings,
      {
        scopeSignature: 'all:',
        chunkingStrategy: 'fixed-size',
        structureChunkingUnit: 'section',
        fixedChunkSize: 256,
      },
    );

    expect(snapshot.fixedChunkSize).toBe(256);
    expect(snapshot.chunks).toHaveLength(4);
    expect(snapshot.chunkingComparison.fixedSize.chunkCount).toBe(4);
    expect(snapshot.chunkingComparison.fixedSize.p95Characters).toBe(256);
    expect(snapshot.chunks.every((chunk) => [...chunk.text].length <= 256)).toBe(true);
    expect([...snapshot.chunks[1]!.text].slice(0, 32)).toEqual(
      [...snapshot.chunks[0]!.text].slice(-32),
    );
  });

  it('caps fixed-size overlap at 400 characters', async () => {
    const embeddings = new FakeEmbeddings();
    const content = Array.from({ length: 20_100 }, (_, index) =>
      String.fromCodePoint(0x1000 + (index % 3000)),
    ).join('');
    const snapshot = await buildIndex(
      [{ path: 'Large.md', content, mtime: 1 }],
      embeddings,
      {
        scopeSignature: 'all:',
        chunkingStrategy: 'fixed-size',
        structureChunkingUnit: 'section',
        fixedChunkSize: 20_000,
      },
    );

    expect(snapshot.chunks).toHaveLength(2);
    expect([...snapshot.chunks[1]!.text].slice(0, 400)).toEqual(
      [...snapshot.chunks[0]!.text].slice(-400),
    );
  });

  it('reports Unicode character metrics using the same units as chunk limits', async () => {
    const snapshot = await buildIndex(
      [{ path: 'Emoji.md', content: '😀'.repeat(300), mtime: 1 }],
      new FakeEmbeddings(),
      {
        scopeSignature: 'all:',
        chunkingStrategy: 'fixed-size',
        structureChunkingUnit: 'section',
        fixedChunkSize: 256,
      },
    );

    expect(snapshot.chunkingComparison.sourceCharacters).toBe(300);
    expect(snapshot.chunkingComparison.fixedSize.p95Characters).toBe(256);
  });

  it('embeds the selected structural unit and records it in comparison metadata', async () => {
    const snapshot = await buildIndex(
      [{ path: 'Whole.md', content: '# One\nAlpha\n\nBeta\n# Two\nGamma', mtime: 1 }],
      new FakeEmbeddings(),
      {
        scopeSignature: 'all:',
        chunkingStrategy: 'structure-aware',
        structureChunkingUnit: 'file',
        fixedChunkSize: 3200,
      },
    );

    expect(snapshot.structureChunkingUnit).toBe('file');
    expect(snapshot.chunkingComparison.structureChunkingUnit).toBe('file');
    expect(snapshot.chunks).toHaveLength(1);
    expect(snapshot.chunks[0]?.text).toContain('# Two');
  });

  it('adds the Markdown heading path to paragraph embedding context without changing stored text', async () => {
    const embeddings = new FakeEmbeddings();
    const snapshot = await buildIndex(
      [{ path: 'Auth.md', content: '# Аутентификация\nНастройте параметр.', mtime: 1 }],
      embeddings,
      {
        scopeSignature: 'all:',
        chunkingStrategy: 'structure-aware',
        structureChunkingUnit: 'paragraph',
        fixedChunkSize: 3200,
      },
    );

    expect(embeddings.calls.flat()).toEqual(['Аутентификация\nНастройте параметр.']);
    expect(snapshot.chunks[0]?.text).toBe('Настройте параметр.');
    expect(snapshot.chunks[0]?.metadata.section).toBe('Аутентификация');
  });

  it('embeds structural chunks one at a time by default', async () => {
    const embeddings = new FakeEmbeddings();
    await buildIndex(
      [
        { path: 'One.md', content: 'One\n\nTwo', mtime: 1 },
        { path: 'Three.md', content: 'Three', mtime: 1 },
      ],
      embeddings,
      {
        scopeSignature: 'all:',
        chunkingStrategy: 'structure-aware',
        structureChunkingUnit: 'paragraph',
        fixedChunkSize: 3200,
      },
    );

    expect(embeddings.calls).toEqual([['One'], ['Two'], ['Three']]);
  });

  it('identifies an oversized structural chunk by source and section', async () => {
    const embeddings = new FakeEmbeddings();
    embeddings.embed = async () => {
      throw new Error('Ollama вернула ошибку HTTP 400.');
    };

    await expect(
      buildIndex(
        [{ path: 'Large.md', content: '# Huge\nVery large section', mtime: 1 }],
        embeddings,
        {
          scopeSignature: 'all:',
          chunkingStrategy: 'structure-aware',
          structureChunkingUnit: 'section',
          fixedChunkSize: 3200,
        },
      ),
    ).rejects.toThrow(/«Large\.md», раздел «Huge».*слишком велик/i);
  });
});
