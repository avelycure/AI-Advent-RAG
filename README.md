# AI Advent RAG

Desktop-only Obsidian plugin for local semantic search and RAG chat over a vault.

The **Day 25** build turns the verified DeepSeek RAG panel into a persistent mini-chat. It keeps recent dialogue and a structured task memory locally, uses both on every follow-up, and still accepts RAG answers only when their sources and verbatim quotes can be verified against retrieved chunks.

## Requirements

- Obsidian desktop
- Node.js 22.12 or newer for development
- A DeepSeek API key with API billing enabled.
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
7. Save the DeepSeek API key under **API-ключ DeepSeek**. Obsidian keeps the value in `SecretStorage`; plugin data stores only its ID.
8. Choose **Использовать RAG** for grounded answers or disable it for the baseline mode.
9. Enable **Фильтрация и переформулирование запроса** for improved retrieval, or disable it to compare with basic RAG. Configure top-K before filtering, the similarity threshold, and top-K after filtering.
10. Open **Чат с DeepSeek** from the ribbon or command palette and send a question.

Every grounded RAG answer contains the answer plus an explicit **Источники и проверенные цитаты** section with `source`, `section`, `chunk_id`, and a verbatim quote. The plugin checks all four values against the local index before displaying the response. Invalid model output gets one repair attempt; a second failure is replaced by a safe “Не знаю” response. Clicking a source opens the note at the indexed line. The chat also displays the current goal, clarified facts, constraints, and user-defined terms in a **Память задачи** card. Chat history and task memory survive Obsidian restarts until **Очистить чат** is selected. Note changes are reconciled by a weekly incremental update during the night; if Obsidian was closed, the overdue update runs the next time it starts.

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

## Day 22 — first RAG request

The two request paths are:

```text
Without RAG: question + recent chat history → DeepSeek → answer
With RAG:    question → local Qwen search → bounded source context + question + history → DeepSeek → answer + local source links
```

The DeepSeek client is pinned to the official `https://api.deepseek.com` endpoint and uses the Chat Completions API. The default model is `deepseek-flash` with thinking disabled for predictable cost and latency, while the model field remains editable. The question is limited to 4,000 characters, recent model context to 12 turns / 16,000 characters, and source context to 50,000 characters. The panel prevents duplicate concurrent sends. Since Day 25, up to 80 messages and the task memory are persisted locally.

The reproducible set of ten expected questions and sources lives in [`eval/day22-control-questions.json`](eval/day22-control-questions.json). The scoring rubric and result table live in [`docs/day-22-quality-comparison.md`](docs/day-22-quality-comparison.md). The evaluation uses the same DeepSeek model for both modes.

## Day 23 — query rewrite, filtering, and reranking

The improved retrieval path is:

```text
question + recent mode-specific history
  → DeepSeek query rewrite
  → local Qwen search for candidate top-K
  → configurable similarity threshold
  → source-aware heuristic reranking and sibling-section expansion
  → final top-K
  → DeepSeek answer with the selected note fragments
```

The baseline mode embeds the original question, applies no relevance threshold or query rewrite, and sends at most the configured final top-K. The improved mode first uses DeepSeek to resolve contextual references such as “it” or “that recipe”. After the configurable similarity minimum, query-token matches in source metadata are preferred as anchors; a strong semantic score is used as a fallback when metadata has no lexical match. Anchored sources within `0.05` of the best anchor are retained; content-rich sections receive a small heuristic bonus, while heading-only and frontmatter chunks receive a penalty. This preserves useful sibling sections when a title chunk scores higher than the actual answer text.

Default retrieval settings are 20 candidates, a `0.35` similarity threshold, and at most 5 final chunks. The chat shows the rewritten query, candidate and result counts, final similarity values, and every fragment sent to DeepSeek. Baseline and improved histories are isolated so switching modes does not contaminate the comparison.

The contextual evaluation set is [`eval/day23-control-questions.json`](eval/day23-control-questions.json), the complete API output is written to `eval/day23-results.json`, and the scored comparison is documented in `docs/day-23-quality-comparison.md`. Reproduce it with:

```bash
npm run eval:day23 -- "/path/to/vault" --confirm-send-notes
```

## Day 24 — citations, sources, and anti-hallucination checks

The grounded answer path is:

```text
retrieved chunks
  → DeepSeek structured JSON answer
  → local schema validation
  → exact source / section / chunk_id validation
  → verbatim quote validation against chunk text
  → rendered answer + trusted source links + quotes
```

For an answered response, the model must return `status=answered`, an answer containing `[S…]` references, and a non-empty source list. Every source entry includes the exact `source`, `section`, `chunk_id`, and a contiguous quote from the corresponding chunk. Unknown IDs, changed metadata, missing citations, or fabricated quotes are rejected locally. The model gets one constrained repair request; if that also fails, the unverified answer is never displayed.

When improved retrieval leaves no chunks at or above the configured similarity threshold, the answer-generation request is skipped. The plugin responds: “Не знаю … Пожалуйста, уточните вопрос.” Model-level `not_enough_context` responses must use the same wording contract and contain no fabricated evidence.

The ten answerable control questions and one separate weak-context control live in `eval/day24-control-questions.json`. Complete structured output and validation results are written to `eval/day24-results.json`; the human-readable table is in `docs/day-24-grounding-evaluation.md`. Reproduce the run with:

```bash
npm run eval:day24 -- "/path/to/vault" --confirm-send-notes
```

## Day 25 — persistent mini-chat and task memory

The production-like chat path is:

```text
new user message + recent mode-specific history + previous task memory
  → DeepSeek task-memory update (goal, clarified facts, constraints, terms)
  → DeepSeek query rewrite with the updated memory
  → local Qwen retrieval, filtering, and reranking
  → DeepSeek grounded answer with history, memory, and retrieved chunks
  → local source, metadata, and verbatim-quote validation
  → local persistence of the compact chat state
```

The three chat modes—without RAG, basic RAG, and improved RAG—keep separate histories and task memories, so switching a comparison mode does not leak context into another one. The persisted file is `rag-chat-state.json` in the plugin directory. It contains message text, compact source metadata, citations, diagnostics, and task memory, but never stores vector values or duplicate chunk text. Writes are atomic and the file is created with owner-only permissions where the operating system supports them.

Two reproducible ten-message conversations live in `eval/day25-long-scenarios.json`: a weekend cooking plan and an October BJJ training plan. Each turn checks that a validated source and exact quote are returned; the final checks verify that the goal, constraints, and defined term remain in task memory. Complete output is written to `eval/day25-results.json` and summarized in `docs/day-25-long-chat-evaluation.md`. Reproduce the run with:

```bash
npm run eval:day25 -- "/path/to/vault" --confirm-send-notes
```

## Checks

```bash
npm test
npm run build
npm run lint
```

## Privacy

- Embeddings and the vector index stay local.
- The local index contains the full unencrypted text of indexed chunks.
- Without RAG, questions and recent mode-specific chat history are sent to the DeepSeek API. Task memory is not updated in this mode.
- With basic RAG, the question, recent history, and previous task memory are first sent to DeepSeek to update goal, facts, constraints, and terms. The question, updated memory, trusted source metadata, and exact selected fragments are then sent for grounded answer generation.
- With improved RAG, the same task-memory update is followed by a separate DeepSeek query-rewrite request. The question, recent mode-specific history, updated memory, filtered fragments, vault-relative source paths, sections, and chunk IDs are then sent for answer generation and citation selection.
- The API key is stored through Obsidian `SecretStorage`, not in plugin `data.json`.
- Up to 80 recent messages and task memory are saved locally in `rag-chat-state.json`; full retrieved chunk text and vectors are not duplicated into this file.
- **Очистить чат** deletes the persisted history and all task memories.
- The plugin does not include telemetry.
