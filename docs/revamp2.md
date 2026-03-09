# Axiom — Remaining Pipeline Changes: Full Implementation Prompt

You are implementing the remaining optimizations for the Axiom desktop study app's indexing and embedding pipeline.
The app is Electron + TypeScript. Read every section before writing any code. Implement in the exact order listed.

**Current state of the codebase:**
- Model: `Xenova/bge-small-en-v1.5` (384-dim) — already switched
- LanceDB dim: already fixed to 384
- Single embedder worker exists at `src/main/workers/embedder.ts`
- Indexer at `src/main/indexing/indexer.ts`
- Vector store at `src/main/database/vectorStore.ts`
- Search handler at `src/main/ipc/searchHandlers.ts`
- Migrations at `src/main/database/migrations.ts`
- App entry at `src/main/index.ts`

---

## CHANGE 1 — Create `src/main/workers/embedderManager.ts` (NEW FILE)

This is the highest priority fix. The search timeout flood is caused by a single shared worker being blocked by indexing batches. This file creates two dedicated workers — one for search, one for indexing — so they never block each other.

Create this file from scratch:

```typescript
import { Worker } from 'worker_threads';
import path from 'path';

const SEARCH_TIMEOUT_MS = 8000;
const INDEX_TIMEOUT_MS  = 60_000;

let searchWorker: Worker | null = null;
let indexWorker:  Worker | null = null;
let msgCounter = 0;

type PendingCall = {
  resolve: (v: number[][]) => void;
  reject:  (e: Error)      => void;
};

const searchPending = new Map<number, PendingCall>();
const indexPending  = new Map<number, PendingCall>();

function spawnWorker(workerPath: string, pending: Map<number, PendingCall>): Worker {
  const w = new Worker(workerPath);

  w.on('message', (msg: { id: number; type: string; vectors?: number[][]; error?: string }) => {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.type === 'error') p.reject(new Error(msg.error));
    else p.resolve(msg.vectors ?? []);
  });

  w.on('error', err => {
    for (const [id, p] of pending) {
      p.reject(err);
      pending.delete(id);
    }
  });

  w.on('exit', code => {
    if (code !== 0) {
      for (const [id, p] of pending) {
        p.reject(new Error(`Worker exited with code ${code}`));
        pending.delete(id);
      }
    }
  });

  return w;
}

function sendInit(worker: Worker, modelsDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const id = ++msgCounter;
    const timer = setTimeout(() => reject(new Error('Worker init timed out')), 30_000);
    worker.once('message', msg => {
      if (msg.id === id && msg.type === 'ready') { clearTimeout(timer); resolve(); }
      else { clearTimeout(timer); reject(new Error('Unexpected init response')); }
    });
    worker.postMessage({ id, type: 'init', modelsDir });
  });
}

function callWorker(
  worker: Worker,
  pending: Map<number, PendingCall>,
  texts: string[],
  timeoutMs: number
): Promise<number[][]> {
  return new Promise((resolve, reject) => {
    const id = ++msgCounter;

    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Embed timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    pending.set(id, {
      resolve: v => { clearTimeout(timer); resolve(v); },
      reject:  e => { clearTimeout(timer); reject(e); },
    });

    worker.postMessage({ id, type: 'embed', texts });
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function initEmbedders(modelsDir: string): Promise<void> {
  const workerPath = path.join(__dirname, 'embedder.js');
  searchWorker = spawnWorker(workerPath, searchPending);
  indexWorker  = spawnWorker(workerPath, indexPending);
  // Load model in both workers in parallel
  await Promise.all([
    sendInit(searchWorker, modelsDir),
    sendInit(indexWorker,  modelsDir),
  ]);
}

/** Use for search queries — dedicated worker, never blocked by indexing */
export function embedQuery(texts: string[]): Promise<number[][]> {
  if (!searchWorker) throw new Error('Search worker not initialized');
  return callWorker(searchWorker, searchPending, texts, SEARCH_TIMEOUT_MS);
}

/** Use for indexing batches — dedicated worker, never blocks search */
export function embedChunks(texts: string[]): Promise<number[][]> {
  if (!indexWorker) throw new Error('Index worker not initialized');
  return callWorker(indexWorker, indexPending, texts, INDEX_TIMEOUT_MS);
}

export function teardownEmbedders(): void {
  searchWorker?.terminate();
  indexWorker?.terminate();
  searchWorker = null;
  indexWorker  = null;
}
```

---

## CHANGE 2 — Update `src/main/workers/embedder.ts`

Add WASM hardware acceleration flags and export the prefix constants. Find the `init` function and replace it entirely:

```typescript
// ── ADD these exports at the top of the file ──────────────────────────────────
export const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';
export const DOC_PREFIX   = 'Represent this document for retrieval: ';
export const MODEL_NAME   = 'Xenova/bge-small-en-v1.5';
export const MODEL_BATCH  = 48;

// ── REPLACE the init function with this ───────────────────────────────────────
async function init(modelsDir: string): Promise<void> {
  env.cacheDir = modelsDir;

  // CRITICAL: numThreads defaults to 1 without this — 3-4x slower
  env.backends.onnx.wasm.numThreads = navigator.hardwareConcurrency ?? 4;
  env.backends.onnx.wasm.simd       = true;   // SIMD vectorized ops
  env.backends.onnx.wasm.proxy      = false;  // run directly in worker thread

  extractor = await pipeline('feature-extraction', MODEL_NAME, {
    quantized: true,
    dtype: 'q8',  // int8 quant: ~2x faster, <1% accuracy loss
  });
}

// ── REPLACE the message handler to match embedderManager's protocol ───────────
self.onmessage = async (event: MessageEvent) => {
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

// ── embedBatch — internal sub-batching (keep existing logic, just verify) ─────
async function embedBatch(texts: string[]): Promise<number[][]> {
  if (!extractor) throw new Error('Embedder not initialized');
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += MODEL_BATCH) {
    const sub    = texts.slice(i, i + MODEL_BATCH);
    const output = await extractor(sub, { pooling: 'mean', normalize: true });
    const dim    = output.dims[1];
    for (let j = 0; j < sub.length; j++) {
      results.push(Array.from(output.data.slice(j * dim, (j + 1) * dim) as Float32Array));
    }
  }

  return results;
}
```

---

## CHANGE 3 — Update `src/main/database/migrations.ts`

### 3a — Add WAL pragmas immediately after db is opened

Find where `db` is created/opened and add these lines directly after. They must run before any reads or writes:

```typescript
// Add immediately after db is opened — before any other db operations
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');   // safe with WAL, much faster than FULL
db.pragma('cache_size = -64000');    // 64MB page cache
db.pragma('temp_store = MEMORY');
db.pragma('mmap_size = 268435456'); // 256MB memory-mapped I/O
```

### 3b — Add new migration for `text_hash` column and `embed_cache` table

Add this as the next migration in sequence (increment the migration number to match your existing sequence):

```typescript
// Migration: add text_hash to chunks + embed_cache table
db.exec(`
  ALTER TABLE chunks ADD COLUMN text_hash TEXT;
  CREATE INDEX IF NOT EXISTS idx_chunks_text_hash ON chunks(text_hash);

  CREATE TABLE IF NOT EXISTS embed_cache (
    text_hash  TEXT    PRIMARY KEY,
    vector     TEXT    NOT NULL,
    model      TEXT    NOT NULL,
    created_at INTEGER DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_embed_cache_model ON embed_cache(model);
`);
```

### 3c — Add `checkModelCompatibility` function

Add this exported function to the file:

```typescript
import { getOrCreateVectorTable, dropVectorTable } from './vectorStore';

const CURRENT_MODEL     = 'Xenova/bge-small-en-v1.5';
const CURRENT_MODEL_DIM = 384;

export async function checkModelCompatibility(vaultPath: string): Promise<void> {
  const stored = db.prepare(
    "SELECT value FROM settings WHERE key = 'embedding_model'"
  ).get() as { value: string } | undefined;

  if (!stored || stored.value !== CURRENT_MODEL) {
    console.warn(
      `[compat] Model changed: ${stored?.value ?? 'none'} → ${CURRENT_MODEL}. Purging vectors + cache.`
    );
    // Drop and recreate the LanceDB table with correct dim
    await dropVectorTable(vaultPath);
    // Clear embed cache — vectors are now invalid
    db.prepare('DELETE FROM embed_cache').run();
    // Force full reindex of all files
    db.prepare('UPDATE files SET indexed_at = NULL').run();
  }

  db.prepare(
    "INSERT OR REPLACE INTO settings(key, value) VALUES('embedding_model', ?)"
  ).run(CURRENT_MODEL);
  db.prepare(
    "INSERT OR REPLACE INTO settings(key, value) VALUES('embedding_dim', ?)"
  ).run(String(CURRENT_MODEL_DIM));
}
```

### 3d — Add prepared statements created once at init (not inside hot loops)

Add these near the top of the file after db is opened so they're reused across all batches:

```typescript
export const stmts = {
  insertChunk: db.prepare(`
    INSERT OR REPLACE INTO chunks
      (id, file_id, page_or_slide, text, chunk_index, is_annotation, text_hash)
    VALUES
      (@id, @file_id, @page_or_slide, @text, @chunk_index, @is_annotation, @text_hash)
  `),
  insertFts: db.prepare(`
    INSERT INTO chunks_fts(rowid, text, file_id, page_or_slide)
    VALUES ((SELECT rowid FROM chunks WHERE id = @id), @text, @file_id, @page_or_slide)
  `),
  getEmbedCache: db.prepare(
    'SELECT vector FROM embed_cache WHERE text_hash = ? AND model = ?'
  ),
  insertEmbedCache: db.prepare(
    'INSERT OR REPLACE INTO embed_cache(text_hash, vector, model) VALUES(?, ?, ?)'
  ),
};

// Single-transaction batch insert — ~50x faster than individual inserts
export const insertChunkBatch = db.transaction((chunks: ChunkRow[]) => {
  for (const c of chunks) {
    stmts.insertChunk.run(c);
    stmts.insertFts.run(c);
  }
});
```

---

## CHANGE 4 — Create `src/main/indexing/embedCache.ts` (NEW FILE)

```typescript
import crypto from 'crypto';
import { db, stmts } from '../database/migrations';

const CURRENT_MODEL = 'Xenova/bge-small-en-v1.5';

// Session-level in-memory cache — fast path, avoids DB lookup for recently seen chunks
const SESSION_CACHE = new Map<string, number[]>();

export function sha256(input: Buffer | string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Check in-memory cache first, then DB.
 * Returns the cached vector or null if not found.
 */
export function queryEmbedCache(textHash: string): number[] | null {
  // Fast path — in-memory
  const mem = SESSION_CACHE.get(textHash);
  if (mem) return mem;

  // DB path
  const row = stmts.getEmbedCache.get(textHash, CURRENT_MODEL) as { vector: string } | undefined;
  if (!row) return null;

  const vec = JSON.parse(row.vector) as number[];
  SESSION_CACHE.set(textHash, vec); // promote to memory
  return vec;
}

/**
 * Persist a new vector to both the in-memory cache and the DB embed_cache table.
 * Always call this after computing a new embedding.
 */
export function saveEmbedCache(textHash: string, vector: number[]): void {
  SESSION_CACHE.set(textHash, vector);
  stmts.insertEmbedCache.run(textHash, JSON.stringify(vector), CURRENT_MODEL);
}

/**
 * Call once at app startup — pre-populates in-memory cache from DB.
 * Limits to 50k entries to avoid excessive memory use.
 * Only loads entries for the current model (stale model entries are ignored).
 */
export function warmEmbedCache(): void {
  const rows = db.prepare(
    'SELECT text_hash, vector FROM embed_cache WHERE model = ? LIMIT 50000'
  ).all(CURRENT_MODEL) as { text_hash: string; vector: string }[];

  for (const row of rows) {
    SESSION_CACHE.set(row.text_hash, JSON.parse(row.vector));
  }
  console.log(`[embedCache] Warmed ${rows.length} entries into session cache`);
}

/**
 * Clear the session cache (e.g. after model change).
 */
export function clearSessionCache(): void {
  SESSION_CACHE.clear();
}
```

---

## CHANGE 5 — Update `src/main/database/vectorStore.ts`

### 5a — Add dim guard to `addVectors`

Find the `addVectors` function and add a validation block at the top before any LanceDB call:

```typescript
const VECTOR_DIM = 384; // bge-small-en-v1.5 — update here if model changes

export async function addVectors(vaultPath: string, rows: VectorRow[]): Promise<void> {
  // ── Runtime dim guard — prevents cryptic LanceDB schema errors ────────────
  for (const row of rows) {
    if (!row.vector || row.vector.length !== VECTOR_DIM) {
      throw new Error(
        `addVectors: dim mismatch for chunk ${row.id}. ` +
        `Expected ${VECTOR_DIM}, got ${row.vector?.length ?? 0}. ` +
        `Did the model change? Run checkModelCompatibility() on startup.`
      );
    }
  }

  const table = await getOrCreateVectorTable(vaultPath);
  await table.add(rows);
}
```

### 5b — Add dim detection to `getOrCreateVectorTable`

Find `getOrCreateVectorTable` and add schema mismatch detection:

```typescript
export async function getOrCreateVectorTable(vaultPath: string) {
  const ldb        = await lancedb.connect(path.join(vaultPath, '.axiom', 'vectors'));
  const tableNames = await ldb.tableNames();

  if (tableNames.includes('chunk_vectors')) {
    const table  = await ldb.openTable('chunk_vectors');
    const schema = await table.schema();

    const vectorField  = schema.fields.find((f: any) => f.name === 'vector');
    const existingDim  = (vectorField?.type as any)?.listSize ?? null;

    if (existingDim !== null && existingDim !== VECTOR_DIM) {
      console.warn(
        `[vectorStore] Dim mismatch: table=${existingDim}, model=${VECTOR_DIM}. Dropping table.`
      );
      await ldb.dropTable('chunk_vectors');
      // Fall through to create fresh table below
    } else {
      return table;
    }
  }

  // Create table with correct dim via seed row
  return await ldb.createTable('chunk_vectors', [
    {
      id:            '__seed__',
      file_id:       '__seed__',
      page_or_slide: 0,
      text:          '',
      vector:        Array(VECTOR_DIM).fill(0),
    },
  ]);
}

export async function dropVectorTable(vaultPath: string): Promise<void> {
  try {
    const ldb = await lancedb.connect(path.join(vaultPath, '.axiom', 'vectors'));
    const tableNames = await ldb.tableNames();
    if (tableNames.includes('chunk_vectors')) {
      await ldb.dropTable('chunk_vectors');
      console.log('[vectorStore] Dropped chunk_vectors table');
    }
  } catch (err) {
    console.error('[vectorStore] Failed to drop table:', err);
  }
}
```

---

## CHANGE 6 — Update `src/main/indexing/indexer.ts`

### 6a — Replace extraction with async generator

Find the existing `extractPages` call and replace with an async generator so embedding starts while extraction continues:

```typescript
async function* extractPagesStream(
  filePath: string,
  raw: Buffer
): AsyncGenerator<{ page: number; text: string }> {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.pdf') {
    // existing PDF worker call — collect and yield page by page
    const pages = await extractPdfPages(filePath, raw); // your existing worker call
    for (const p of pages) {
      if (wordCount(p.text) >= 20) yield p;
    }
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

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
```

### 6b — Add contextual chunk helpers

Add these two helper functions to the file:

```typescript
/**
 * Build the text that gets embedded (NOT stored in FTS).
 * Prepends filename + nearest section heading to give the model document context.
 * Result is prepended with DOC_PREFIX before embedding.
 */
function buildEmbedText(chunkText: string, filePath: string, headingCtx: string): string {
  const fileName = path.basename(filePath, path.extname(filePath));
  return [fileName, headingCtx, chunkText].filter(Boolean).join('\n\n');
}

/**
 * Walk backward through pageText to find the nearest Markdown heading or
 * ALL-CAPS line (common slide title pattern) before the current position.
 */
function extractHeadingContext(pageText: string, charOffset?: number): string {
  const text  = charOffset != null ? pageText.slice(0, charOffset) : pageText;
  const lines = text.split('\n');
  const last  = [...lines].reverse().find(
    l => /^#{1,6}\s/.test(l) || /^[A-Z][A-Z\s]{5,}$/.test(l.trim())
  );
  return last ? last.replace(/^#+\s*/, '').trim() : '';
}
```

### 6c — Replace `indexFile` body with streaming pipeline

Replace the existing `indexFile` implementation with this. Keep the function signature identical:

```typescript
import { embedChunks }                from '../workers/embedderManager';
import { queryEmbedCache, saveEmbedCache, sha256 } from './embedCache';
import { insertChunkBatch, stmts }   from '../database/migrations';
import { addVectors }                from '../database/vectorStore';
import { DOC_PREFIX }                from '../workers/embedder';

const EMBED_SUB_BATCH     = 32;
const MAX_CHUNKS_PER_FILE = 5000;

export async function indexFile(filePath: string, vaultPath: string): Promise<void> {
  if (!isSupportedExtension(filePath)) return;

  await withFileLock(filePath, async () => {
    if (!fs.existsSync(filePath)) return;

    const raw         = fs.readFileSync(filePath);
    const stat        = fs.statSync(filePath);
    const contentHash = sha256(raw);

    // Skip if unchanged
    const existing = db.prepare(
      'SELECT id, mtime_ms, content_hash FROM files WHERE path = ?'
    ).get(filePath) as FileRow | undefined;

    if (existing?.mtime_ms === stat.mtimeMs && existing?.content_hash === contentHash) {
      return;
    }

    if (existing) await purgeFile(existing.id, vaultPath);

    const fileId = existing?.id ?? uuid();
    upsertFile({ id: fileId, path: filePath, stat, contentHash, vaultPath });

    let totalChunks    = 0;
    const pendingBatch: ChunkRow[] = [];

    for await (const page of extractPagesStream(filePath, raw)) {
      if (totalChunks >= MAX_CHUNKS_PER_FILE) break;

      const pieces     = chunkText(page.text, { maxTokens: 300, overlap: 50 });
      const headingCtx = extractHeadingContext(page.text);

      for (let idx = 0; idx < pieces.length; idx++) {
        if (totalChunks >= MAX_CHUNKS_PER_FILE) break;

        const textHash  = sha256(pieces[idx]);
        const embedText = buildEmbedText(pieces[idx], filePath, headingCtx);

        pendingBatch.push({
          id:            uuid(),
          file_id:       fileId,
          page_or_slide: page.page,
          chunk_index:   idx,
          text:          pieces[idx],       // stored in SQLite / FTS — plain text
          embed_text:    embedText,          // used only for embedding — not stored
          text_hash:     textHash,
          is_annotation: 0,
        });
        totalChunks++;

        if (pendingBatch.length >= EMBED_SUB_BATCH) {
          await flushBatch(pendingBatch.splice(0, EMBED_SUB_BATCH), vaultPath);
          emitProgress(fileId, totalChunks);
        }
      }
    }

    if (pendingBatch.length > 0) {
      await flushBatch(pendingBatch, vaultPath);
    }

    db.prepare('UPDATE files SET indexed_at = ? WHERE id = ?').run(Date.now(), fileId);
    emitProgress(fileId, totalChunks, totalChunks); // final 100%
  });
}

async function flushBatch(chunks: ChunkRow[], vaultPath: string): Promise<void> {
  // ── Check embed cache for each chunk ────────────────────────────────────────
  const toEmbed:  ChunkRow[]          = [];
  const vecMap:   Map<string, number[]> = new Map();

  for (const chunk of chunks) {
    const cached = queryEmbedCache(chunk.text_hash);
    if (cached) {
      vecMap.set(chunk.id, cached);
    } else {
      toEmbed.push(chunk);
    }
  }

  // ── Embed only uncached chunks ───────────────────────────────────────────────
  if (toEmbed.length > 0) {
    const texts   = toEmbed.map(c => DOC_PREFIX + c.embed_text);
    const vectors = await embedChunks(texts);  // uses dedicated index worker

    toEmbed.forEach((chunk, i) => {
      vecMap.set(chunk.id, vectors[i]);
      saveEmbedCache(chunk.text_hash, vectors[i]); // persist to DB + session cache
    });
  }

  // ── Write chunks to SQLite in one transaction ────────────────────────────────
  insertChunkBatch(chunks);

  // ── Write vectors to LanceDB ─────────────────────────────────────────────────
  const vectorRows = chunks
    .map(c => ({
      id:            c.id,
      file_id:       c.file_id,
      page_or_slide: c.page_or_slide,
      text:          c.text,
      vector:        vecMap.get(c.id) ?? [],
    }))
    .filter(r => r.vector.length > 0); // skip if embed failed

  if (vectorRows.length > 0) {
    await addVectors(vaultPath, vectorRows);
  }
}

function emitProgress(fileId: string, chunksProcessed: number, totalChunks?: number): void {
  // Replace mainWindow with however your app holds a reference to the BrowserWindow
  mainWindow?.webContents.send('vault:indexProgress', {
    fileId,
    chunksProcessed,
    totalChunks: totalChunks ?? null,
    timestamp:   Date.now(),
  });
}
```

---

## CHANGE 7 — Update `src/main/ipc/searchHandlers.ts`

### 7a — Replace shared worker embed call with `embedQuery`

Find every call to `embedWorker.embed(...)` or equivalent in the search handler and replace:

```typescript
import { embedQuery }              from '../workers/embedderManager';
import { QUERY_PREFIX }            from '../workers/embedder';

// ── In hybridSearch — replace the semantic embed call ─────────────────────────
const SEMANTIC_TIMEOUT_MS    = 8000;
const COSINE_THRESHOLD       = 0.3;  // discard results below this similarity

const semPromise = embedQuery([QUERY_PREFIX + expandedQuery])
  .then(([vec]) => searchVectors(vaultPath, vec, 30))
  .then(rows => rows.filter(r => r.score >= COSINE_THRESHOLD))  // ← new threshold filter
  .catch(() => [] as VectorHit[]);
```

### 7b — Add in-flight guard to prevent parallel embed calls from rapid typing

Find the top of the search handler and add:

```typescript
// ── In-flight guard — prevents parallel embed calls from rapid keystrokes ─────
let searchInFlight: Promise<SearchResult[]> | null = null;

export async function handleSearch(
  query: string,
  vaultPath: string,
  subject?: string
): Promise<SearchResult[]> {
  if (!query.trim()) return [];

  // Wait for any running search to complete before starting a new one
  if (searchInFlight) {
    await searchInFlight.catch(() => {});
  }

  searchInFlight = hybridSearch(query, vaultPath, subject)
    .finally(() => { searchInFlight = null; });

  return searchInFlight;
}
```

---

## CHANGE 8 — Update `src/main/index.ts`

Replace the existing startup sequence. The critical rules are:
1. `checkModelCompatibility` MUST complete before `startVaultWatcher`
2. `initEmbedders` MUST complete before `startVaultWatcher`
3. `warmEmbedCache` runs after DB is ready

```typescript
import { initEmbedders, teardownEmbedders } from './workers/embedderManager';
import { checkModelCompatibility }          from './database/migrations';
import { warmEmbedCache }                   from './indexing/embedCache';

app.whenReady().then(async () => {
  // 1. Open DB + apply WAL pragmas
  initDb();

  // 2. Check model compat — drops stale LanceDB table + resets indexed_at if needed
  //    MUST run before watcher so no bad writes get through
  await checkModelCompatibility(vaultPath);

  // 3. Warm in-memory embed cache from DB (avoids re-embedding on first session)
  warmEmbedCache();

  // 4. Spawn and load both embedder workers
  //    MUST complete before watcher so first file event has a worker ready
  await initEmbedders(modelsDir);

  // 5. Start vault watcher — safe to start now
  startVaultWatcher(vaultPath);
});

// Clean up workers on quit
app.on('before-quit', () => {
  teardownEmbedders();
  runMaintenance(); // see Change 9
  db.close();
});
```

---

## CHANGE 9 — Create `src/main/database/maintenance.ts` (NEW FILE)

```typescript
import { db } from './migrations';

/**
 * Run after large deletions (purgeFile, full re-index, model change).
 * Do NOT run on every indexing operation — only after bulk changes.
 */
export function runMaintenance(): void {
  try {
    db.pragma('analysis_limit = 1000');
    db.exec('ANALYZE');
    db.pragma('wal_checkpoint(TRUNCATE)'); // compact WAL file
    console.log('[maintenance] ANALYZE + WAL checkpoint complete');
  } catch (err) {
    console.error('[maintenance] Failed:', err);
  }
}
```

---

## CHANGE 10 — Add Search Debounce on the Renderer Side

Find the search input handler in the renderer (wherever the user types a query and triggers `ipcRenderer.invoke('vault:search', ...)`). Add a 300ms debounce:

```typescript
// Renderer process — wherever search input is handled
// If you already have a debounce, increase it to 300ms minimum

function debounce<T extends (...args: any[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout>;
  return ((...args: any[]) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  }) as T;
}

const doSearch = debounce((query: string) => {
  if (!query.trim()) return;
  ipcRenderer.invoke('vault:search', query)
    .then(results => renderResults(results))
    .catch(console.error);
}, 300); // 300ms — only fires after user pauses typing

// Wire to your input element
searchInput.addEventListener('input', e => {
  doSearch((e.target as HTMLInputElement).value);
});
```

---

## Summary — Files Changed

| File | Action |
|---|---|
| `src/main/workers/embedderManager.ts` | **CREATE** — two-worker split |
| `src/main/workers/embedder.ts` | **EDIT** — WASM flags, prefixes, message protocol |
| `src/main/database/migrations.ts` | **EDIT** — WAL pragmas, text_hash migration, embed_cache table, prepared stmts, checkModelCompatibility |
| `src/main/indexing/embedCache.ts` | **CREATE** — session cache + DB cache helpers |
| `src/main/database/vectorStore.ts` | **EDIT** — dim guard in addVectors, dim detection in getOrCreateVectorTable, dropVectorTable |
| `src/main/indexing/indexer.ts` | **EDIT** — streaming pipeline, buildEmbedText, extractHeadingContext, flushBatch, emitProgress |
| `src/main/ipc/searchHandlers.ts` | **EDIT** — embedQuery, QUERY_PREFIX, cosine threshold, in-flight guard |
| `src/main/index.ts` | **EDIT** — startup order, initEmbedders, warmEmbedCache, teardown on quit |
| `src/main/database/maintenance.ts` | **CREATE** — runMaintenance |
| Renderer search input | **EDIT** — 300ms debounce |

## Do NOT change
- `purgeFile` logic — correct as-is
- `chokidar` watcher setup — keep `awaitWriteFinish` and stability debounce
- FTS5 table schema — do not rename columns
- `chunkText` parameters — keep `maxTokens: 300`, `overlap: 50`
- LanceDB table name `chunk_vectors` — keep consistent
- `EMBED_SUB_BATCH = 32` and `MODEL_BATCH = 48` — already tuned

---

*Implement strictly in the order listed (1 → 10). Each change depends on the previous. After Change 1 + 2 + 7 the search timeout flood will stop. After Change 6 indexing speed will improve significantly.*