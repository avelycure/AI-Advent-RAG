import { describe, expect, it } from 'vitest';
import type { App } from 'obsidian';
import { IndexController } from '../src/indexing/index-controller';
import type {
  EmbeddingClient,
  IndexRepository,
  PluginSettings,
  VectorIndexSnapshot,
} from '../src/types';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { indexedChunk, indexSnapshot } from './test-fixtures';

class MemoryRepository implements IndexRepository {
  readonly format = 'binary' as const;
  snapshot: VectorIndexSnapshot | null = null;
  async load(): Promise<VectorIndexSnapshot | null> {
    return this.snapshot;
  }
  async save(snapshot: VectorIndexSnapshot): Promise<void> {
    this.snapshot = snapshot;
  }
}

class FakeEmbeddings implements EmbeddingClient {
  calls: string[][] = [];
  fingerprint = 'digest';
  async embed(input: string[]): Promise<number[][]> {
    this.calls.push(input);
    return input.map((text) => [text.includes('changed') ? 2 : 1, 1]);
  }
  async testConnection(): Promise<void> {}
  async getFingerprint(): Promise<string> {
    return this.fingerprint;
  }
}

describe('index controller', () => {
  it('rejects a legacy index instead of reusing incompatible chunks', async () => {
    const repository = new MemoryRepository();
    repository.snapshot = indexSnapshot([indexedChunk('legacy')], {
      schemaVersion: 1,
      chunkerVersion: 1,
    });
    const app = { vault: {} } as unknown as App;
    const controller = new IndexController(app, new FakeEmbeddings(), repository);

    await expect(controller.load()).rejects.toThrow(/несовместимой версией/i);
    expect(controller.getSnapshot()).toBeNull();
  });

  it('rejects the immediately previous index schema', async () => {
    const repository = new MemoryRepository();
    repository.snapshot = indexSnapshot([indexedChunk('legacy-v3')], { schemaVersion: 3 });
    const controller = new IndexController(
      { vault: {} } as unknown as App,
      new FakeEmbeddings(),
      repository,
    );

    await expect(controller.load()).rejects.toThrow(/несовместимой версией/i);
    expect(controller.getSnapshot()).toBeNull();
  });

  it('weekly update embeds only changed notes and keeps unchanged chunks', async () => {
    const files = [
      { path: 'A.md', stat: { mtime: 1 } },
      { path: 'B.md', stat: { mtime: 1 } },
    ];
    const contents = new Map([
      ['A.md', '# A\noriginal'],
      ['B.md', '# B\noriginal'],
    ]);
    const app = {
      vault: {
        getMarkdownFiles: () => files,
        cachedRead: (file: { path: string }) => Promise.resolve(contents.get(file.path) ?? ''),
      },
    } as unknown as App;
    const embeddings = new FakeEmbeddings();
    const repository = new MemoryRepository();
    const controller = new IndexController(app, embeddings, repository);
    const settings: PluginSettings = { ...DEFAULT_SETTINGS, selectedFolders: [] };

    const original = await controller.rebuild(settings);
    embeddings.calls = [];
    files[1]!.stat.mtime = 2;
    contents.set('B.md', '# B\nchanged');
    const updated = await controller.update(settings);

    expect(embeddings.calls.flat()).toHaveLength(1);
    expect(updated.chunks).toHaveLength(2);
    expect(
      updated.chunks.find((chunk) => chunk.metadata.source === 'B.md')?.text,
    ).toContain('changed');
    expect(updated.chunkingComparison.sourceCharacters).not.toBe(
      original.chunkingComparison.sourceCharacters,
    );
  });

  it('keeps Unicode character metrics consistent after an incremental update', async () => {
    const files = [{ path: 'Emoji.md', stat: { mtime: 1 } }];
    let content = '😀'.repeat(300);
    const app = {
      vault: {
        getMarkdownFiles: () => files,
        cachedRead: () => Promise.resolve(content),
      },
    } as unknown as App;
    const controller = new IndexController(app, new FakeEmbeddings(), new MemoryRepository());

    const original = await controller.rebuild(DEFAULT_SETTINGS);
    expect(original.chunkingComparison.sourceCharacters).toBe(300);

    content = '😀'.repeat(301);
    files[0]!.stat.mtime = 2;
    const updated = await controller.update(DEFAULT_SETTINGS);
    expect(updated.chunkingComparison.sourceCharacters).toBe(301);
  });

  it('fully rebuilds when the installed embedding model fingerprint changes', async () => {
    const files = [{ path: 'A.md', stat: { mtime: 1 } }];
    const app = {
      vault: {
        getMarkdownFiles: () => files,
        cachedRead: () => Promise.resolve('# A\noriginal'),
      },
    } as unknown as App;
    const embeddings = new FakeEmbeddings();
    const controller = new IndexController(app, embeddings, new MemoryRepository());
    const settings: PluginSettings = { ...DEFAULT_SETTINGS, selectedFolders: [] };

    await controller.rebuild(settings);
    embeddings.calls = [];
    embeddings.fingerprint = 'new-digest';
    const updated = await controller.update(settings);

    expect(embeddings.calls.flat()).toHaveLength(1);
    expect(updated.embeddingFingerprint).toBe('new-digest');
  });

  it('fully rebuilds when the chunking strategy changes', async () => {
    const files = [{ path: 'A.md', stat: { mtime: 1 } }];
    const app = {
      vault: {
        getMarkdownFiles: () => files,
        cachedRead: () => Promise.resolve('# A\noriginal'),
      },
    } as unknown as App;
    const embeddings = new FakeEmbeddings();
    const controller = new IndexController(app, embeddings, new MemoryRepository());

    await controller.rebuild({ ...DEFAULT_SETTINGS, chunkingStrategy: 'structure-aware' });
    embeddings.calls = [];
    const updated = await controller.update({
      ...DEFAULT_SETTINGS,
      chunkingStrategy: 'fixed-size',
    });

    expect(embeddings.calls.flat()).toHaveLength(1);
    expect(updated.chunkingStrategy).toBe('fixed-size');
  });

  it('fully rebuilds when the structural unit changes', async () => {
    const files = [{ path: 'A.md', stat: { mtime: 1 } }];
    const app = {
      vault: {
        getMarkdownFiles: () => files,
        cachedRead: () => Promise.resolve('# A\nfirst paragraph\n\nsecond paragraph'),
      },
    } as unknown as App;
    const embeddings = new FakeEmbeddings();
    const controller = new IndexController(app, embeddings, new MemoryRepository());

    await controller.rebuild({
      ...DEFAULT_SETTINGS,
      chunkingStrategy: 'structure-aware',
      structureChunkingUnit: 'section',
    });
    embeddings.calls = [];
    const updated = await controller.update({
      ...DEFAULT_SETTINGS,
      chunkingStrategy: 'structure-aware',
      structureChunkingUnit: 'paragraph',
    });

    expect(embeddings.calls.flat()).toHaveLength(2);
    expect(updated.structureChunkingUnit).toBe('paragraph');
    expect(updated.chunks).toHaveLength(2);
  });

  it('fully rebuilds when the configured fixed chunk size changes', async () => {
    const files = [{ path: 'A.md', stat: { mtime: 1 } }];
    const app = {
      vault: {
        getMarkdownFiles: () => files,
        cachedRead: () => Promise.resolve('A'.repeat(900)),
      },
    } as unknown as App;
    const embeddings = new FakeEmbeddings();
    const controller = new IndexController(app, embeddings, new MemoryRepository());

    await controller.rebuild({ ...DEFAULT_SETTINGS, fixedChunkSize: 600 });
    embeddings.calls = [];
    const updated = await controller.update({ ...DEFAULT_SETTINGS, fixedChunkSize: 256 });

    expect(embeddings.calls.flat()).toHaveLength(4);
    expect(updated.fixedChunkSize).toBe(256);
    expect(updated.chunks).toHaveLength(4);
  });
});
