## Axiom — Speed & Accuracy Optimizations: Copilot Prompt

---

**Context**

You are optimizing the indexing and search pipeline of Axiom, a local-first Electron + TypeScript desktop study app. The stack is `@xenova/transformers` for embeddings, LanceDB for vector storage, better-sqlite3 with FTS5 for keyword search, and a hybrid search handler that merges both result sets. Read every section before touching any code. Implement in the order listed.

---

**Optimization 1 — ANN Vector Index on LanceDB (do this first)**

After bulk indexing completes and on vault open, build an IVF-PQ approximate nearest neighbour index on the `chunk_vectors` table in LanceDB. Without this, every search is a brute-force linear scan across all vectors. With it, search becomes sub-linear — the single biggest speed win available.

Build the index after the initial vault scan finishes indexing, not after every single file. Also rebuild it after a full reindex triggered by a model compatibility change. Do not rebuild it on every incremental file change — only on bulk operations.

---

**Optimization 2 — Replace Linear Score Merging with Reciprocal Rank Fusion**

Find the merge logic in `searchHandlers.ts` where FTS BM25 scores and semantic cosine scores are combined using weighted multiplication. Replace this entirely with Reciprocal Rank Fusion.

RRF works on ranks not scores. Each result gets a rank in its respective result list (1st, 2nd, 3rd...). The RRF score is the sum of `1 / (k + rank)` for each list it appears in, where k = 60. Results that appear in both lists get contributions from both. Sort by final RRF score descending.

Remove the `ftsWeight`, `semWeight`, and intent-classification weight logic entirely — RRF doesn't need tuned weights. Keep the annotation boost (×1.3) applied after RRF scoring. Keep the cosine threshold filter before merging.

---

**Optimization 3 — Transferable ArrayBuffers in the Embedder Worker**

In `embedder.ts`, when posting vectors back to the main thread after inference, transfer the underlying ArrayBuffer instead of structured-cloning it. This makes the transfer zero-copy — no memory duplication on large batches.

Convert the vector arrays to `Float32Array` before posting, pass the underlying `.buffer` as the message payload, and include it in the transferables list in `postMessage`. Update `embedderManager.ts` to reconstruct the `number[][]` arrays from the received `Float32Array` buffers on the receiving side.

---

**Optimization 4 — Sentence-Boundary Chunking**

Find `chunkText` in `indexer.ts`. Currently it cuts text at exactly 300 tokens regardless of sentence boundaries, which produces incomplete sentences at chunk edges and degrades embedding quality.

Change it to target 300 tokens but always finish the current sentence before cutting. Use sentence-ending punctuation (`. `, `? `, `! `, `\n\n`) as valid cut points. If no sentence boundary exists within a reasonable window around the 300-token target, fall back to the hard cut. This produces semantically complete chunks which embed more accurately.

---

**Optimization 5 — Parallel PDF Page Extraction**

Find the PDF extraction logic in the PDF worker inside `indexer.ts`. Currently pages are extracted sequentially one by one. Change this to extract pages in parallel batches of 4 concurrent pages at a time. Use `Promise.all` over sliding windows of 4 pages. Keep the existing per-page timeout (2000ms) and overall file timeout (120000ms). Keep skipping pages under 20 words.

---

**Optimization 6 — Parent-Child Chunking for AI Vault Injection**

This affects only the vault-grounded AI flow — not regular search results shown in the sidebar.

Store chunks at 300 tokens as today (child chunks) — these are what get embedded and searched. But for each child chunk, also store a reference to its parent context: the surrounding 600 tokens of text centred on that chunk (the 150 tokens before it and the 150 tokens after it on the same page).

Add a `parent_text` column to the `chunks` table via a new migration. Populate it during indexing — it is never embedded, never indexed in FTS, purely used for context retrieval.

In the vault injection path (`vaultInject.ts` or `searchHandlers.ts` where the top-5 chunks are assembled for the AI prompt), replace `chunk.text` with `chunk.parent_text` when building the prompt. The AI sees richer context; retrieval precision is unaffected because search still runs on the small child embeddings.

---

**Optimization 7 — Dynamic Overlap Based on File Type**

Find where `overlap: 50` is passed to `chunkText` in `indexer.ts`. Replace the hardcoded value with a function that returns the overlap based on file type and page length:

- Dense PDFs (type `pdf`, page word count over 200): 80 tokens
- Markdown notes (type `md`): 30 tokens  
- Slide decks (type `pptx`): 0 — slides are self-contained, cross-slide overlap creates noise
- Annotations (`is_annotation = true`): 0 — always short, overlap is meaningless
- Plain text (type `txt`): 50 — keep current

---

**Do NOT change:**
- Model name, prefix constants (`QUERY_PREFIX`, `DOC_PREFIX`), or `MODEL_BATCH`
- The dual-worker architecture in `embedderManager.ts`
- SQLite WAL pragmas
- The embed cache logic in `embedCache.ts`
- The `EMBED_SUB_BATCH = 32` write batching
- The `MAX_CHUNKS_PER_FILE = 5000` cap
- Chunk size of 300 tokens (child chunks) — do not change this
- LanceDB `VECTOR_DIM = 384` or the dim guard in `addVectors`
- `purgeFile` logic
- FTS5 schema

---

**Implementation order: 1 → 2 → 3 → 4 → 5 → 6 → 7**

Optimizations 1 and 2 are the highest impact and lowest risk — verify them working before proceeding to the rest. Optimization 6 requires a migration, write it carefully and increment the migration version number.