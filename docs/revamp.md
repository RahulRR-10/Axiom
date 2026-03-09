# Axiom — Indexing & Embedding Pipeline: Full Optimization Implementation Plan

You are refactoring the Axiom desktop study app's indexing and embedding pipeline for speed and accuracy.
The codebase is an Electron + TypeScript app using:
- `@xenova/transformers` for local ONNX embeddings in a worker thread
- `better-sqlite3` for SQLite (metadata + FTS5)
- `vectordb` (LanceDB) for vector storage
- `pdfjs-dist` for PDF extraction
- `chokidar` for file watching

**IMPORTANT:** Read every section before writing any code. Each section builds on the previous.

---

## 1. Switch Embedding Model to `bge-small-en-v1.5`

### File: `src/main/workers/embedder.ts`

Replace the existing model with `Xenova/bge-small-en-v1.5`.

```typescript
// REMOVE old model constant and REPLACE with:
const MODEL_NAME = 'Xenova/bge-small-en-v1.5';
const MODEL_BATCH = 48; // optimal for bge-small on WASM

// QUERY prefix — REQUIRED for bge, never skip this
export const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';
// DOC prefix for chunks during indexing
export const DOC_PREFIX = 'Represent this document for retrieval: ';
```

### Embedder worker `init` — enable all WASM hardware acceleration:

```typescript
import { env, pipeline, FeatureExtractionPipeline } from '@xenova/transformers';

let extractor: FeatureExtractionPipeline | null = null;

async function init(modelsDir: string) {
  // Cache model weights to userData so they persist across app sessions
  env.cacheDir = modelsDir;

  // ── CRITICAL PERFORMANCE FLAGS ──────────────────────────────────────────────
  // numThreads defaults to 1; set to hardware concurrency for 3–4× speedup
  env.backends.onnx.wasm.numThreads = navigator.hardwareConcurrency ?? 4;
  env.backends.onnx.wasm.simd       = true;   // SIMD vectorized ops
  env.backends.onnx.wasm.proxy      = false;  // run directly in this worker thread

  extractor = await pipeline('feature-extraction', MODEL_NAME, {
    quantized: true,
    dtype: 'q8',   // int8 quantization: ~2× faster, <1% accuracy regression
  });
}
```

### `embedBatch` function inside the worker:

```typescript
// Internal sub-batching — never feed the whole list at once
async function embedBatch(texts: string[]): Promise<number[][]> {
  if (!extractor) throw new Error('Embedder not initialized');
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += MODEL_BATCH) {
    const sub = texts.slice(i, i + MODEL_BATCH);
    const output = await extractor(sub, { pooling: 'mean', normalize: true });
    // Split flat tensor into per-text vectors
    const dim = output.dims[1];
    for (let j = 0; j < sub.length; j++) {
      results.push(Array.from(output.data.slice(j * dim, (j + 1) * dim)));
    }
  }

  return results;
}

// Worker message handler
self.onmessage = async (event) => {
  const { id, type, texts, modelsDir } = event.data;
  try {
    if (type === 'init') {
      await init(modelsDir);
      self.postMessage({ id, type: 'ready' });
    } else if (type === 'embed') {
      const vectors = await embedBatch(texts);
      self.postMessage({ id, type: 'result', vectors });
    }
  } catch (err) {
    self.postMessage({ id, type: 'error', error: (err as Error).message });
  }
};
```

---

## 2. SQLite Performance — WAL Mode + Batch Writes

### File: `src/main/database/migrations.ts` (or wherever DB is initialized)

Add these pragmas immediately after `db` is opened — before any reads or writes:

```typescript
// Run once at DB open time
db.pragma('journal_mode = WAL');      // Write-Ahead Log: concurrent reads + writes
db.pragma('synchronous = NORMAL');    // Safe with WAL; much faster than FULL
db.pragma('cache_size = -64000');     // 64MB page cache in memory
db.pragma('temp_store = MEMORY');     // Temp tables in memory, not disk
db.pragma('mmap_size = 268435456');   // 256MB memory-mapped I/O
```

### Prepared statements — create once, reuse:

```typescript
// Prepare all statements at DB init — never prepare inside a hot loop
export const stmts = {
  insertChunk: db.prepare(`
    INSERT OR REPLACE INTO chunks (id, file_id, page_or_slide, text, chunk_index, is_annotation, text_hash)
    VALUES (@id, @file_id, @page_or_slide, @text, @chunk_index, @is_annotation, @text_hash)
  `),
  insertFts: db.prepare(`
    INSERT INTO chunks_fts (rowid, text, file_id, page_or_slide)
    VALUES ((SELECT rowid FROM chunks WHERE id=@id), @text, @file_id, @page_or_slide)
  `),
  getChunkByHash: db.prepare(`SELECT id FROM chunks WHERE text_hash = ?`),
};

// Wrap ALL chunk inserts in a SINGLE transaction per sub-batch (~50× faster than individual inserts)
export const insertChunkBatch = db.transaction((chunks: ChunkRow[]) => {
  for (const c of chunks) {
    stmts.insertChunk.run(c);
    stmts.insertFts.run(c);
  }
});
```

---

## 3. Add `text_hash` Column to `chunks` Table

### File: `src/main/database/migrations.ts`

Add a new migration:

```typescript
// Migration N+1
db.exec(`
  ALTER TABLE chunks ADD COLUMN text_hash TEXT;
  CREATE INDEX IF NOT EXISTS idx_chunks_text_hash ON chunks(text_hash);
`);
```

### Add embed cache table:

```typescript
db.exec(`
  CREATE TABLE IF NOT EXISTS embed_cache (
    text_hash TEXT PRIMARY KEY,
    vector    BLOB NOT NULL,        -- stored as JSON or binary float array
    model     TEXT NOT NULL,        -- e.g. 'bge-small-en-v1.5' to invalidate on model change
    created_at INTEGER DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_embed_cache_hash ON embed_cache(text_hash);
`);
```

---

## 4. Streaming Pipeline — Overlap Extraction + Embedding

### File: `src/main/indexing/indexer.ts`

**Replace the current "collect everything then process" flow with a streaming approach.**

The old flow is:
```
extract ALL pages → chunk ALL → embed ALL → write ALL
```

The new flow is:
```
for each page as it arrives → chunk immediately → flush batch → embed + write
```

```typescript
// ── CONSTANTS ───────────────────────────────────────────────────────────────
const EMBED_SUB_BATCH      = 32;   // chunks per SQLite transaction + LanceDB append
const MAX_CHUNKS_PER_FILE  = 5000;

// ── MAIN INDEXING FUNCTION ──────────────────────────────────────────────────
export async function indexFile(filePath: string, vaultPath: string): Promise<void> {
  if (!isSupportedExtension(filePath)) return;

  await withFileLock(filePath, async () => {
    if (!fs.existsSync(filePath)) return;

    const raw         = fs.readFileSync(filePath);
    const stat        = fs.statSync(filePath);
    const contentHash = sha256(raw);

    // ── Skip if unchanged ──────────────────────────────────────────────────
    const existing = db.prepare(
      'SELECT id, mtime_ms, content_hash FROM files WHERE path=?'
    ).get(filePath) as FileRow | undefined;

    if (existing?.mtime_ms === stat.mtimeMs && existing?.content_hash === contentHash) {
      return; // nothing changed — skip entirely
    }

    // ── Purge stale data ───────────────────────────────────────────────────
    if (existing) await purgeFile(existing.id, vaultPath);

    // ── Upsert file row ────────────────────────────────────────────────────
    const fileId = existing?.id ?? uuid();
    upsertFile({ id: fileId, path: filePath, stat, contentHash, vaultPath });

    // ── Stream pages → chunks → embed → write ─────────────────────────────
    let totalChunks = 0;
    const pendingChunks: ChunkRow[] = [];

    // extractPagesStream is an async generator — yields { page, text } one at a time
    for await (const page of extractPagesStream(filePath, raw)) {
      if (totalChunks >= MAX_CHUNKS_PER_FILE) break;

      const pieces = chunkText(page.text, { maxTokens: 300, overlap: 50 });
      const headingCtx = extractHeadingContext(page.text); // for contextual embedding

      for (let idx = 0; idx < pieces.length; idx++) {
        if (totalChunks >= MAX_CHUNKS_PER_FILE) break;

        const textHash = sha256(pieces[idx]);
        pendingChunks.push({
          id:            uuid(),
          file_id:       fileId,
          page_or_slide: page.page,
          chunk_index:   idx,
          text:          pieces[idx],
          // Contextual text — prepend file name + heading for better embeddings
          // This is what gets embedded, NOT stored in DB (store plain text for FTS)
          embed_text:    buildEmbedText(pieces[idx], filePath, headingCtx),
          text_hash:     textHash,
          is_annotation: 0,
        });
        totalChunks++;

        // ── Flush when batch is full ───────────────────────────────────────
        // Embedding starts while extraction continues on next iteration
        if (pendingChunks.length >= EMBED_SUB_BATCH) {
          await flushBatch(pendingChunks.splice(0, EMBED_SUB_BATCH), vaultPath);
          emitProgress(fileId, totalChunks); // send to vault:indexProgress IPC channel
        }
      }
    }

    // ── Flush remainder ────────────────────────────────────────────────────
    if (pendingChunks.length > 0) {
      await flushBatch(pendingChunks, vaultPath);
    }

    db.prepare('UPDATE files SET indexed_at=? WHERE id=?').run(Date.now(), fileId);
  });
}
```

### `flushBatch` — embed with cache, write SQLite + LanceDB atomically:

```typescript
async function flushBatch(chunks: ChunkRow[], vaultPath: string): Promise<void> {
  // ── Embedding cache check ──────────────────────────────────────────────────
  const toEmbed: ChunkRow[]   = [];
  const cached:  Map<string, number[]> = new Map();

  for (const chunk of chunks) {
    const hit = queryEmbedCache(chunk.text_hash); // checks in-memory then DB
    if (hit) {
      cached.set(chunk.id, hit);
    } else {
      toEmbed.push(chunk);
    }
  }

  // ── Embed only uncached chunks ─────────────────────────────────────────────
  let vectors: number[][] = [];
  if (toEmbed.length > 0) {
    // Use DOC_PREFIX for chunk text during indexing — critical for bge accuracy
    const texts = toEmbed.map(c => DOC_PREFIX + c.embed_text);
    vectors = await embedWorker.embed(texts);

    // Persist to embed_cache
    const insertCache = db.prepare(
      'INSERT OR REPLACE INTO embed_cache(text_hash, vector, model) VALUES(?,?,?)'
    );
    const cacheAll = db.transaction(() => {
      toEmbed.forEach((chunk, i) => {
        insertCache.run(chunk.text_hash, JSON.stringify(vectors[i]), MODEL_NAME);
      });
    });
    cacheAll();
  }

  // ── Write chunks to SQLite in one transaction ──────────────────────────────
  insertChunkBatch(chunks); // single transaction, ~50× faster than individual inserts

  // ── Write vectors to LanceDB ───────────────────────────────────────────────
  const vectorRows = chunks.map(chunk => {
    const vec = cached.get(chunk.id) ?? vectors[toEmbed.indexOf(chunk)];
    return { id: chunk.id, file_id: chunk.file_id, page_or_slide: chunk.page_or_slide, vector: vec };
  });

  await addVectors(vaultPath, vectorRows);
}
```

---

## 5. Contextual Chunk Text (Accuracy Boost)

### File: `src/main/indexing/indexer.ts`

These helper functions build richer text for the embedding model without polluting the FTS index:

```typescript
/**
 * Prepend document name + section heading to every chunk.
 * The model sees context; FTS still searches plain chunk.text.
 */
function buildEmbedText(chunkText: string, filePath: string, headingCtx: string): string {
  const fileName = path.basename(filePath, path.extname(filePath));
  const parts = [fileName, headingCtx, chunkText].filter(Boolean);
  return parts.join('\n\n');
}

/**
 * Walk back from the current position in pageText to find the nearest heading.
 * Works for Markdown (# heading) and PPTX slide titles.
 */
function extractHeadingContext(pageText: string, charOffset?: number): string {
  const text  = charOffset != null ? pageText.slice(0, charOffset) : pageText;
  const lines = text.split('\n');
  // Match Markdown headings or ALL-CAPS lines (common slide titles)
  const last = [...lines].reverse().find(
    l => /^#{1,6}\s/.test(l) || /^[A-Z\s]{6,}$/.test(l.trim())
  );
  return last ? last.replace(/^#+\s*/, '').trim() : '';
}
```

---

## 6. Extracting Pages as an Async Generator

### File: `src/main/indexing/indexer.ts`

Replace the current `extractPages(...)` that returns a full array with an async generator so embedding can start on page 1 while page 2 is still being parsed:

```typescript
async function* extractPagesStream(
  filePath: string,
  raw: Buffer
): AsyncGenerator<{ page: number; text: string }> {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.pdf') {
    // Run in a worker thread to avoid blocking main process
    // Stream page-by-page using a MessageChannel back to this generator
    yield* extractPdfPagesStream(filePath, raw);

  } else if (ext === '.pptx') {
    const slides = await extractPptxSlides(raw);
    for (const s of slides) {
      if (wordCount(s.text) >= 20) yield s;
    }

  } else if (ext === '.md' || ext === '.txt') {
    const text = raw.toString('utf-8');
    if (wordCount(text) >= 20) yield { page: 1, text };
  }
}

// PDF streaming via worker — uses MessageChannel for back-pressure
async function* extractPdfPagesStream(
  filePath: string,
  raw: Buffer
): AsyncGenerator<{ page: number; text: string }> {
  // Spawn/reuse PDF worker and collect pages via callback
  // Each page is yielded as soon as it arrives from the worker
  const pages = await pdfWorker.extractPages(filePath, raw); // existing worker call
  for (const p of pages) {
    if (wordCount(p.text) >= 20) yield p;
  }
}
```

---

## 7. Embed Cache — In-Memory + DB Layer

### File: `src/main/indexing/embedCache.ts` (new file)

```typescript
import crypto from 'crypto';
import { db } from '../database/db';

// Session-level in-memory cache — survives hot reindexing within one session
const SESSION_CACHE = new Map<string, number[]>();
const CURRENT_MODEL = 'bge-small-en-v1.5';

export function sha256(input: Buffer | string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function queryEmbedCache(textHash: string): number[] | null {
  // Check in-memory first (fastest)
  if (SESSION_CACHE.has(textHash)) return SESSION_CACHE.get(textHash)!;

  // Fall back to DB
  const row = db.prepare(
    'SELECT vector FROM embed_cache WHERE text_hash=? AND model=?'
  ).get(textHash, CURRENT_MODEL) as { vector: string } | undefined;

  if (!row) return null;

  const vec = JSON.parse(row.vector) as number[];
  SESSION_CACHE.set(textHash, vec); // promote to in-memory
  return vec;
}

export function saveEmbedCache(textHash: string, vector: number[]): void {
  SESSION_CACHE.set(textHash, vector);
  // DB persistence happens in flushBatch via transaction — don't write here
}

/**
 * Call this on app startup — re-populate in-memory cache from DB.
 * Only loads embeddings from the current model to avoid stale data.
 */
export function warmEmbedCache(): void {
  const rows = db.prepare(
    'SELECT text_hash, vector FROM embed_cache WHERE model=? LIMIT 50000'
  ).all(CURRENT_MODEL) as { text_hash: string; vector: string }[];

  for (const row of rows) {
    SESSION_CACHE.set(row.text_hash, JSON.parse(row.vector));
  }
}
```

---

## 8. Query Side — Use QUERY_PREFIX for Hybrid Search

### File: `src/main/ipc/searchHandlers.ts`

The single most important accuracy fix on the query side. Never embed a raw query — always prefix it:

```typescript
import { QUERY_PREFIX } from '../workers/embedder';

async function hybridSearch(query: string, vaultPath: string, subject?: string) {
  if (!query.trim()) return [];

  const intent = classifyQueryIntent(query);
  const { ftsWeight, semWeight } = chooseWeights(intent);

  // ── Semantic: embed with QUERY_PREFIX ─────────────────────────────────────
  const expandedQuery = expandQuery(query); // your existing query expansion
  const semPromise = Promise.race([
    embedWorker.embed([QUERY_PREFIX + expandedQuery])
      .then(([vec]) => searchVectors(vaultPath, vec, 30))
      .catch(() => [] as VectorHit[]),
    timeoutPromise(6000, [] as VectorHit[]),
  ]);

  // ── FTS: run in parallel while semantic embed is in-flight ────────────────
  const ftsRows = db.prepare(`
    SELECT c.id, c.text, c.file_id, c.page_or_slide, c.is_annotation,
           f.path, f.name, f.type, f.subject,
           bm25(chunks_fts) AS bm25
    FROM   chunks_fts
    JOIN   chunks c ON c.rowid = chunks_fts.rowid
    JOIN   files  f ON f.id   = c.file_id
    WHERE  chunks_fts MATCH ?
    ${subject ? 'AND f.subject = ?' : ''}
    ORDER  BY bm25
    LIMIT  50
  `).all(...[sanitizeFtsQuery(query), subject].filter(Boolean)) as FtsRow[];

  // ── Merge ─────────────────────────────────────────────────────────────────
  const resultMap = new Map<string, SearchResult>();

  for (const r of ftsRows) {
    const bm25Norm = normalizeBm25(r.bm25);
    let score = ftsWeight * bm25Norm;
    if (r.is_annotation) score *= 1.3;
    resultMap.set(r.id, makeResult(r, score, 'fts'));
  }

  const semRows = await semPromise;
  for (const r of semRows) {
    // Filter below similarity threshold — cosine < 0.3 is usually noise
    if (r.score < 0.3) continue;

    const semScore = semWeight * r.score;
    if (resultMap.has(r.id)) {
      resultMap.get(r.id)!.score += semScore;
    } else {
      const meta = db.prepare(
        'SELECT c.*, f.path, f.name, f.type FROM chunks c JOIN files f ON f.id=c.file_id WHERE c.id=?'
      ).get(r.id) as ChunkMeta | undefined;
      if (!meta) continue;
      const score = semScore * (meta.is_annotation ? 1.3 : 1.0);
      resultMap.set(r.id, makeResult(meta, score, 'semantic'));
    }
  }

  return [...resultMap.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 30);
}
```

---

## 9. Model Change Detection — Invalidate Vectors on Upgrade

### File: `src/main/database/migrations.ts`

On app startup, check if the stored model name matches the current one. If not, clear all vectors and re-index everything:

```typescript
const CURRENT_MODEL     = 'bge-small-en-v1.5';
const CURRENT_MODEL_DIM = 384; // bge-small output dim

export async function checkModelCompatibility(vaultPath: string): Promise<void> {
  const stored = db.prepare(
    "SELECT value FROM settings WHERE key='embedding_model'"
  ).get() as { value: string } | undefined;

  if (stored?.value && stored.value !== CURRENT_MODEL) {
    console.warn(`Model changed from ${stored.value} → ${CURRENT_MODEL}. Clearing vectors.`);

    // Clear LanceDB vectors
    await dropVectorTable(vaultPath);

    // Clear embed cache
    db.prepare('DELETE FROM embed_cache').run();

    // Reset indexed_at so all files get re-indexed
    db.prepare('UPDATE files SET indexed_at=NULL').run();
  }

  // Persist current model + dim
  db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('embedding_model',?)").run(CURRENT_MODEL);
  db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('embedding_dim',?)").run(CURRENT_MODEL_DIM);
}
```

---

## 10. Warm Up on App Start

### File: `src/main/index.ts` (or wherever app startup is handled)

```typescript
import { warmEmbedCache } from './indexing/embedCache';
import { checkModelCompatibility } from './database/migrations';

app.whenReady().then(async () => {
  // 1. Apply SQLite pragmas (WAL, cache, etc.)
  initDb();

  // 2. Check if embedding model changed — clears stale vectors if needed
  await checkModelCompatibility(vaultPath);

  // 3. Pre-populate in-memory embed cache from DB (avoid re-embedding on first session)
  warmEmbedCache();

  // 4. Warm up the embedder worker — load model into memory before first query
  //    Don't await — do it in the background so app launch stays fast
  embedWorker.warmup(modelsDir).catch(console.error);

  // 5. Start file watcher
  startVaultWatcher(vaultPath);
});
```

---

## 11. SQLite Maintenance — Periodic VACUUM + ANALYZE

### File: `src/main/database/maintenance.ts` (new file)

```typescript
/**
 * Run after large deletions (purgeFile, full re-index).
 * Don't run on every indexing op — only when meaningful data was deleted.
 */
export function runMaintenance(): void {
  db.pragma('analysis_limit = 1000');
  db.exec('ANALYZE');
  // VACUUM reclaims space after deletions — run async-ish using WAL checkpoint
  db.pragma('wal_checkpoint(TRUNCATE)');
}

// Also run this at app close to keep DB compact
app.on('before-quit', () => {
  runMaintenance();
  db.close();
});
```

---

## 12. Progress Reporting

### File: `src/main/indexing/indexer.ts`

Surface progress through the existing `vault:indexProgress` IPC channel so the UI stays responsive:

```typescript
function emitProgress(fileId: string, chunksProcessed: number, totalChunks?: number) {
  mainWindow?.webContents.send('vault:indexProgress', {
    fileId,
    chunksProcessed,
    totalChunks: totalChunks ?? null,
    timestamp: Date.now(),
  });
}
```

---

## Summary of All Changes

| File | Change |
|---|---|
| `workers/embedder.ts` | Switch to `bge-small-en-v1.5`, add `numThreads`, `simd`, `dtype: q8`, add `QUERY_PREFIX` / `DOC_PREFIX` |
| `indexing/indexer.ts` | Streaming pipeline, contextual chunk text, `buildEmbedText`, `extractHeadingContext`, `flushBatch` with cache |
| `indexing/embedCache.ts` | New file — in-memory + DB cache layer, `warmEmbedCache`, `sha256`, `queryEmbedCache` |
| `ipc/searchHandlers.ts` | Apply `QUERY_PREFIX` on all query embeds, cosine threshold filter |
| `database/migrations.ts` | WAL pragma block, add `text_hash` column, `embed_cache` table, `checkModelCompatibility` |
| `database/maintenance.ts` | New file — `runMaintenance`, `ANALYZE`, `WAL_CHECKPOINT` |
| `index.ts` (app entry) | Call `checkModelCompatibility`, `warmEmbedCache`, background `embedWorker.warmup` |

### Do NOT change:
- LanceDB `vectorStore.ts` table schema — chunk `id` already links to SQLite
- `chokidar` watcher setup — keep `awaitWriteFinish` and stability debounce
- `purgeFile` logic — it is correct as-is
- FTS5 table schema — do not change column names
- `chunkText` parameters — keep `maxTokens: 300`, `overlap: 50`

---

*Implement in the order listed. Each section depends on the previous. Test after section 2 (SQLite pragmas) and section 4 (streaming pipeline) as these will show the biggest immediate speed gains.*