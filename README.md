# AI Advent RAG

Desktop-only Obsidian plugin for local semantic search over a vault.

The current **Day 21** build stops after retrieval: it builds a local vector index with `qwen3-embedding:0.6b` through Ollama and shows the matching note fragments. It does not call an LLM or send note text to a remote provider.

## Requirements

- Obsidian desktop
- Node.js 22.12 or newer for development
- [Ollama](https://ollama.com/) with the embedding model installed:

```bash
ollama pull qwen3-embedding:0.6b
```

## Development

```bash
npm install
npm run dev
```

Copy or symlink the repository into a development vault at:

```text
<vault>/.obsidian/plugins/ai-advent-rag
```

Then enable **AI Advent RAG** under **Settings → Community plugins**.

## Usage

1. Start Ollama and make sure `qwen3-embedding:0.6b` is installed.
2. Open **Settings → AI Advent RAG**.
3. Choose which notes to index: the whole vault, selected folders only, or the whole vault except selected folders.
4. Choose **Фиксированный размер** or **По структуре Markdown** as the chunking strategy. Fixed size is the default; its chunk size can be configured from 256 to 20,000 characters. Structural chunking can use paragraphs, Markdown sections, or complete files as units.
5. Choose the local index format: binary, JSON, SQLite, or FAISS.
6. Select **Перестроить индекс**.
7. Open the search panel with the ribbon button or the **Open semantic search panel** command.

Each result shows the cosine similarity, source, title, section, line range, `chunk_id`, and full fragment text. Clicking the title opens the source note at the indexed line. Note changes are reconciled by a weekly incremental update during the night; if Obsidian was closed, the overdue update runs the next time it starts.

Changing the indexed folder selection requires a rebuild. Updating or replacing the local Qwen embedding model also triggers a full rebuild during the next scheduled update.

## Day 21 — document indexing

The indexing pipeline is:

```text
Markdown notes → chunking → local Qwen embeddings → selected local index
Search query → local Qwen embedding → cosine similarity → matching fragments
```

The storage format is selected in the plugin settings. Changing it does not replace the working index immediately: the new backend becomes active only after a successful rebuild. The available files are:

| Format | Local files | Notes |
| --- | --- | --- |
| Binary | `rag-indexes/rag-index.bin` | Compact default with JSON metadata and contiguous `Float32` vectors |
| JSON | `rag-indexes/rag-index.json` | Human-readable and easy to inspect, but larger |
| SQLite | `rag-indexes/rag-index.sqlite` | Structured tables for metadata, chunks, and vector BLOBs |
| FAISS | `rag-indexes/rag-index.faiss` and `rag-indexes/rag-index.faiss.json` | Real `IndexFlatIP` vector search plus a sidecar containing note text and metadata |

Every backend records:

- `source` — vault-relative note path;
- `title` — note filename;
- `section` — Markdown heading path when available;
- `chunk_id` — deterministic identifier;
- line range, file modification time, content hash, and ordinal.

The selected local storage also contains the full, unencrypted text of every indexed chunk so the search UI can display it. Anyone who can read the plugin directory can therefore recover indexed note fragments. Previous formats are intentionally retained as rollback copies after a successful switch. Index files live in the plugin's `rag-indexes` directory. To remove current and stale derived data, disable the plugin and delete the `rag-indexes` directory; rebuilding creates the selected format again from the notes.

FAISS is a native dependency and must be compatible with the operating system, CPU architecture, and the Node runtime embedded in Obsidian. If it cannot be loaded, the plugin keeps the previously active index and shows a Russian error asking the user to select another format. SQLite is produced by the portable `sql.js` engine and does not require a system SQLite installation.

Two chunking strategies are available. Fixed-size chunking defaults to 3,200 characters and is configurable from 256 to 20,000 characters. Its overlap is calculated automatically as 12.5% of the selected size, capped at 400 characters. Structure-aware chunking preserves the selected semantic unit without applying the fixed-size limit:

| Strategy | Behavior | Typical trade-off |
| --- | --- | --- |
| Fixed size | Splits the complete file into uniform overlapping windows | Predictable chunk sizes, but a window can cross section boundaries |
| Markdown paragraphs | Creates one chunk per blank-line-delimited text block while preserving heading metadata | Precise matches, but less surrounding context |
| Markdown sections | Creates one chunk per heading section | Strong topical context, but long sections produce large chunks |
| Complete files | Creates one chunk per note | Maximum context, but large notes can reduce retrieval precision or exceed embedding-model input limits |

Every rebuild evaluates both strategies locally on the same corpus, while embeddings are generated only for the selected strategy. Settings show document count, source characters, estimated page count, chunk count, average size, p95 size, and section-metadata coverage for both strategies. Using 1,800 characters as one approximate page makes it immediately visible whether the challenge target of 20–30 pages is met.

To reproduce the comparison:

1. Put at least 20–30 pages of Markdown text, README content, articles, or code converted to text into the selected vault folders. A reproducible 27-page corpus can be exported from this repository:

   ```bash
   npm run prepare:day21-corpus -- "/path/to/vault/AI Advent — Day 21"
   ```

2. Rebuild with **Фиксированный размер** and record the comparison plus the top five results for these queries:

   - `How does fixed-size chunking work?`
   - `How is the binary vector index saved?`
   - `What happens when the embedding model fingerprint changes?`

3. Rebuild with **По структуре Markdown** and repeat exactly the same queries.
4. Compare fragment boundaries, section labels, chunk counts, and retrieval ranking.

No LLM participates in this experiment. The only model call is to the local Ollama embedding endpoint.

## Checks

```bash
npm test
npm run build
npm run lint
```

## Privacy

- Embeddings and the vector index stay local.
- Search queries and note fragments are processed only by local Ollama in the current build.
- No remote LLM request is made by the search panel.
- The plugin does not include telemetry.
