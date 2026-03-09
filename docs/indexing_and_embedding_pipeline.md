# Indexing & Embedding Pipeline — Technical Design

## Summary

This document specifies a complete, production-ready indexing and embedding pipeline for Axiom — a local-first desktop study application. It covers file discovery, text extraction, page-level chunking, embedding generation, vector storage, hybrid search, incremental re-indexing, performance considerations, and pseudocode for core operations.

## Assumptions

- Local-first architecture: embeddings run locally via `@xenova/transformers` (transformers.js) in worker threads.
- Metadata stored in SQLite (better-sqlite3) with FTS5; vectors stored in LanceDB (vectordb).
- Supported file types: PDF, PPTX, Markdown (`.md`), plain text (`.txt`).
- Target chunk size ≈ 300 tokens (~300 words), overlap ≈ 50 tokens.
- Production scale: thousands of documents, tens to hundreds of thousands of chunks.

---

## 1) File discovery

- Initial scan
  - On vault open, run a recursive scan to enumerate indexable files and insert `files` rows with `indexed_at = NULL` prior to indexing.
  - Exclude `.axiom/`, dotfiles, and unsupported extensions.

- Change detection
  - Use `chokidar` with `awaitWriteFinish` and a stability debounce to handle `add`, `change`, `unlink` events.
  - For `add`/`change` call `indexFile(filePath, vaultPath)`; for `unlink` call `purgeFile(fileId)`.

- Unchanged detection
  - Store `stat.mtimeMs` and SHA-256 `content_hash` for each file. Skip reindex if both unchanged.

- Concurrency
  - Use a per-file lock to serialize indexing for the same path.

## 2) Document extraction

- PDF
  - Offload to a worker thread using `pdfjs-dist` to avoid blocking the main process.
  - Probe a few sample pages to detect image-only PDFs; timebox per-page and overall extraction (e.g., 2s/page, 120s/file).
  - Emit `[{ page, text }]` for each text-bearing page; skip short pages (e.g., < 20 words).

- PPTX
  - Parse slide text via an office parser; treat each slide as a `page_or_slide` value.

- Markdown / Plain text
  - Treat entire file as a single page `{ page: 1, text: fileContents }`.
  - Optionally preserve headings as pseudo-page anchors for traceability.

- Traceability
  - Keep `file_path`, `file_id`, and `page_or_slide` with every chunk so UI can open the exact page.

## 3) Chunking strategy

- Parameters
  - `maxTokens` = 300; `overlap` = 50.
  - Cap chunks per file to avoid runaway work (e.g., `MAX_CHUNKS_PER_FILE = 5000`).

- Page preservation
  - Chunk only within page boundaries. Each chunk stores `page_or_slide` and `chunk_index`.

- Chunk structure
  - Fields per chunk: `id` (UUID), `file_id`, `page_or_slide`, `chunk_index`, `text`, `is_annotation`.
  - Mirror chunk text to FTS5 virtual table for keyword search.

- Overlap rationale
  - Overlap reduces boundary information loss while keeping growth modest.

## 4) Metadata schema (SQLite)

Use the existing schema as the canonical design. Key tables:

- `files`
  - `id TEXT PK`, `path TEXT UNIQUE`, `name`, `type`, `subject`, `size`, `mtime_ms`, `content_hash`, `indexed_at`, `created_at`.

- `chunks`
  - `id TEXT PK`, `file_id TEXT REFERENCES files(id) ON DELETE CASCADE`, `page_or_slide INTEGER`, `text TEXT`, `chunk_index INTEGER`, `is_annotation INTEGER DEFAULT 0`.

- `chunks_fts`
  - FTS5 virtual table: `text`, `file_id`, `page_or_slide` with `content=chunks` mapping.

- `notes`, `annotations`, `tags`, `file_tags`, `settings`, `schema_migrations`.

(See existing migrations in `src/main/database/migrations.ts`.)

## 5) Embedding generation

- Model & worker
  - Load quantized ONNX model with `transformers.js` in a persistent worker thread that stays alive for the app session.
  - Warm up the worker at app startup or on first indexing request.

- Batching strategy
  - Batch chunks at two levels: indexer batches (`EMBED_SUB_BATCH`, e.g., 32) to control SQLite writes and per-worker `MODEL_BATCH` (e.g., 64) for model throughput.
  - Send `EMBED_SUB_BATCH` to the worker's `embedBatch` API which performs internal batching.

- Caching
  - Cache embeddings keyed by a `text_hash` (SHA-256 of chunk text). If chunk text unchanged and `text_hash` exists, reuse cached vector.
  - Store `text_hash` either as a new column on `chunks` or in a separate `embeds_cache` table mapping `text_hash -> vector_id`.

- Avoid recomputation
  - Only re-embed when parent file changed (content hash differs), chunk text changed, or embedding model changed.
  - For model upgrades store `embedding_model` and `embedding_dim` in `settings` to detect incompatible vectors and schedule re-embedding.

## 6) Vector storage (LanceDB)

- Table design
  - Table (e.g., `chunk_vectors`) stores rows with `id` (chunk id), `file_id`, `page_or_slide`, `text` (optional snapshot), and `vector` float array.
  - Use `id` equal to `chunk.id` so vector results map back to SQLite chunks.

- Linking
  - When vector search returns rows, each row includes `id` and `file_id`. Join with SQLite on `id` to enrich results with chunk text and file metadata.

- Maintenance
  - Provide `deleteVectorsByFileId(vaultPath, fileId)` to purge vectors when a file is deleted or fully reindexed.
  - Cache the LanceDB connection per-vault for reuse.

## 7) Hybrid search workflow

- End-to-end flow
  - User enters `query`.
  - Sanitize query and run FTS5 `MATCH` against `chunks_fts` to retrieve keyword hits (BM25-ranked).
  - In parallel, perform query expansion for semantic intent and embed the expanded query, then run LanceDB cosine similarity search (top-k).
  - Filter semantic results by a cosine similarity threshold.
  - Merge results by chunk `id`: combine normalized BM25 and semantic similarity with tunable weights (e.g., `ftsWeight` + `semWeight`).
  - Apply annotation boost (e.g., ×1.3 for `is_annotation`).
  - Add notes & filename fallbacks as lower-score entries.

- Intent tuning & latency
  - Use a lightweight `classifyQueryIntent` to pick weights (short keyword queries favor FTS, questions favor semantic).
  - Set a timeout for embedding (e.g., 6s) to fallback to FTS-only if the embedder is busy.

## 8) Incremental re-indexing

- Detect updates
  - `indexFile` checks `mtime_ms` and `content_hash`. If unchanged, skip. If changed, call `purgeFile` then reindex.

- Delete stale vectors
  - On purge, delete FTS rows and call `deleteVectorsByFileId` to remove vectors from LanceDB.

- Re-embed changed files only
  - Recompute chunks and only embed current chunks. If page-level hashing is added, re-chunk only changed pages to reduce work.

## 9) Performance considerations

- Indexing speed
  - Use worker threads for PDF extraction and embedding. Batch model inferences.
  - Write chunks to SQLite in transactions per-batch, append vectors per-batch to LanceDB.

- Memory & model limits
  - Use quantized models, tune `MODEL_BATCH` and `EMBED_SUB_BATCH`, and set `resourceLimits` on workers.

- Background workers & concurrency
  - Run a small concurrency pool for file indexing (e.g., 1–3 concurrent files) and a single persistent embedder worker to reuse the loaded model.

- Caching & cold-start
  - Persist model weights to `app.getPath('userData')/models`. Warm the embedder worker on startup or first indexing.

- Maintenance tasks
  - Periodic `VACUUM`/`ANALYZE` for SQLite and compaction for LanceDB after large deletions.

## 10) Data flow diagram (text)

Vault Folder
→ Extraction (PDF/PPTX/MD)
→ Chunking (page-preserving, overlap)
→ SQLite metadata (`files`, `chunks`, `chunks_fts`)
→ Embedding worker (batched)
→ LanceDB vectors (`chunk_vectors`)
→ Hybrid search engine (FTS5 + LanceDB → merge & re-rank)
→ UI (open exact `file_path` + `page_or_slide`)

---

## Pseudocode

### Indexing a new file

```pseudo
function indexFile(filePath, vaultPath):
  if extension not supported: return

  with per-file-lock(filePath):
    if file doesn't exist: return
    stat = fs.stat(filePath)
    raw = fs.readFileSync(filePath)
    contentHash = sha256(raw)

    existing = db.get('SELECT id, mtime_ms, content_hash FROM files WHERE path=?', filePath)
    if existing and existing.mtime_ms == stat.mtimeMs and existing.content_hash == contentHash:
      return  // unchanged

    if existing: purgeFile(existing.id, vaultPath, db)

    subject = inferSubject(vaultPath, filePath)
    upsert files row with (id, path, name, type, subject, size, mtime_ms, content_hash)

    pages = extractPages(filePath, type, raw)  // PDF worker or simple text
    if pages.length == 0:
      mark files.indexed_at = now; return

    allChunks = []
    for page in pages:
       pieces = chunkText(page.text, maxTokens=300, overlap=50)
       for idx, piece in enumerate(pieces):
         allChunks.append({id: uuid(), file_id, page_or_slide: page.page, text: piece, chunk_index: idx})
         if allChunks.length >= MAX_CHUNKS_PER_FILE: break

    for each batch in chunked(allChunks, EMBED_SUB_BATCH):
      db.transaction(() => insert chunk rows and update chunks_fts)
      vectors = embedBatch(batch.texts)  // worker
      addVectors(vaultPath, batch with vectors)  // write to LanceDB

    mark files.indexed_at = now
```

### Embedding worker (simplified)

```pseudo
worker.init(modelsDir):
  transformers.env.cacheDir = modelsDir
  extractor = pipeline('feature-extraction', MODEL_NAME, { quantized: true })

worker.onMessage({ id, texts }):
  vectors = []
  for each subBatch of texts (size MODEL_BATCH):
    output = extractor(subBatch, { pooling: 'mean', normalize: true })
    vectors.extend(split output into per-text vectors)
  postMessage({ id, type: 'result', vectors })
```

### Hybrid search (simplified)

```pseudo
function hybridSearch(query, vaultPath, subject, fileType):
  if query empty: return []

  intent = classifyIntent(query)
  ftsWeight, semWeight = chooseWeights(intent)

  expanded = expandQuery(query)
  semPromise = Promise.race([
    embed(expanded).then(vec => searchVectors(vaultPath, vec, 30)).catch(()=>[]),
    timeoutPromise(EMBED_TIMEOUT_MS, [])
  ])

  // FTS pass
  ftsRows = db.prepare(SELECT ... FROM chunks_fts MATCH ? JOIN files ... LIMIT 50).all(sanitizeFtsQuery(query))
  resultMap = {}
  for r in ftsRows:
    bm25Norm = normalize(r.bm25)
    score = ftsWeight * bm25Norm
    if r.is_annotation: score *= 1.3
    resultMap[r.id] = makeResult(r, score, source='fts')

  // Merge semantic
  semRows = await semPromise
  for r in semRows:
    semScore = semWeight * r.score
    if resultMap[r.id]: resultMap[r.id].score += semScore
    else:
      meta = db.get('SELECT text,... FROM chunks JOIN files WHERE c.id=?', r.id)
      score = semScore * (meta.is_annotation ? 1.3 : 1.0)
      resultMap[r.id] = makeResult(meta, score, source='semantic')

  // Add notes and filename fallbacks
  return topN(sorted(resultMap.values(), by score), 30)
```

---

## Operational recommendations

- Record `embedding_model` and `embedding_dim` in `settings` to detect when vectors must be re-created after model changes.
- Add `text_hash` to `chunks` (or a cache table) to skip embedding unchanged text.
- Consider page-level `pages` table with `page_hash` for partial reindexing of very large PDFs.
- Keep a single persistent embedder worker; keep file-indexing concurrency small.
- Surface progress (extracted pages, chunks, embedded count) via the `vault:indexProgress` channel.

## References to code

- Indexer & chunker: `src/main/indexing/indexer.ts`
- PDF extraction worker: `src/main/indexing/indexer.ts`
- Embedder worker: `src/main/workers/embedder.ts`
- Vector store (LanceDB): `src/main/database/vectorStore.ts`
- DB migrations: `src/main/database/migrations.ts`
- Vault watcher: `src/main/vault/vaultWatcher.ts`
- Search handler / merge logic: `src/main/ipc/searchHandlers.ts`

---

## Next steps

- Optional: add `text_hash` column and a caching table to avoid re-embedding identical chunks.
- Optional: implement page-level hashing for partial reindexing of very large PDFs.

---

*Generated on 2026-03-09 by an automated pipeline design assistant.*
