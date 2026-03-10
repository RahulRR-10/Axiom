import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { BrowserWindow } from 'electron';
import { v4 as uuidv4 } from 'uuid';
import { Worker } from 'worker_threads';

import { embedChunks } from '../workers/embedderManager';
import { DOC_PREFIX, MODEL_NAME } from '../workers/embedder';
import { addVectors, deleteVectorsByFileId } from '../database/vectorStore';
import { getDb } from '../database/schema';
import { writeLog } from '../logger';
import { queryEmbedCache, sha256 } from './embedCache';

// ── Feature flags (vertical-slice gate: Phase 2.9) ───────────────────────────
export const ENABLE_PDF_INDEXING = true;
export const ENABLE_PPTX_INDEXING = false;

// ── Safety limits ────────────────────────────────────────────────────────────
const EMBED_SUB_BATCH = 32;             // chunks sent to embedder worker at a time (keep small to limit ONNX peak memory)
const MAX_CHUNKS_PER_FILE = 5000;       // cap chunks per file
const PDF_PER_PAGE_TIMEOUT_MS = 2_000;  // 2 s per page — real text pages extract in <100ms
const PDF_MIN_WORDS_PER_PAGE = 20;      // pages with fewer words are image-only / blank / OCR noise
const PDF_SAMPLE_PAGES = 5;             // pages to probe before committing to full extraction
const PDF_SAMPLE_TIMEOUT_MS = 1_500;    // tight timeout used only during the sample probe
const PDF_MAX_CONSECUTIVE_TIMEOUTS = 5; // stop processing if this many pages in a row time out

// ── Per-file lock to prevent concurrent indexing of the same path ────────────
const indexLocks = new Map<string, Promise<void>>();

async function withFileLock(filePath: string, fn: () => Promise<void>): Promise<void> {
  const norm = filePath.toLowerCase();
  const prev = indexLocks.get(norm) ?? Promise.resolve();
  const current = prev.then(fn, fn);   // run fn after previous completes (even if it failed)
  indexLocks.set(norm, current);
  try {
    await current;
  } finally {
    // Clean up if no newer call has replaced our entry
    if (indexLocks.get(norm) === current) indexLocks.delete(norm);
  }
}

const SUPPORTED_EXTENSIONS = new Set([
  '.md',
  '.txt',
  ...(ENABLE_PDF_INDEXING ? ['.pdf'] : []),
  ...(ENABLE_PPTX_INDEXING ? ['.pptx'] : []),
]);

type SupportedType = 'md' | 'txt' | 'pdf' | 'pptx';

// ── Public entry point ───────────────────────────────────────────────────────

/**
 * Index a single file into SQLite (text chunks + FTS5) and LanceDB (vectors).
 *
 * Skip conditions:
 *  - Extension not in SUPPORTED_EXTENSIONS
 *  - File unchanged: same mtime_ms AND same content_hash
 *
 * Re-index: deletes all old chunks, FTS rows, and vectors first.
 */
export async function indexFile(filePath: string, vaultPath: string): Promise<void> {
  const ext = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    try { writeLog('indexer:skip', `${path.basename(filePath)} unsupported extension`); } catch { /* ignore */ }
    return;
  }

  try {
    await withFileLock(filePath, () => indexFileInner(filePath, vaultPath));
  } catch (err) {
    try { writeLog('indexer:ERROR', err); } catch { /* ignore */ }
    throw err;
  }
}

async function indexFileInner(filePath: string, vaultPath: string): Promise<void> {
  const ext = path.extname(filePath).toLowerCase();
  const fileType = ext.slice(1) as SupportedType;
  const db = getDb(vaultPath);

  // File may have been deleted between the event and lock acquisition
  if (!fs.existsSync(filePath)) return;

  const stat = fs.statSync(filePath);
  const mtimeMs = stat.mtimeMs;

  const raw = fs.readFileSync(filePath);
  const contentHash = crypto.createHash('sha256').update(raw).digest('hex');

  // ── Check if already indexed and unchanged ───────────────────────────────
  const existing = db
    .prepare('SELECT id, mtime_ms, content_hash FROM files WHERE path = ?')
    .get(filePath) as { id: string; mtime_ms: number; content_hash: string } | undefined;

  if (existing) {
    if (existing.mtime_ms === mtimeMs && existing.content_hash === contentHash) {
      return; // unchanged — skip
    }
    // File changed — clean up old data
    await purgeFile(existing.id, vaultPath, db);
  }

  // ── Determine subject from parent folder name ────────────────────────────
  const subject = path.relative(vaultPath, path.dirname(filePath)).split(path.sep)[0] || null;

  // ── Upsert file record BEFORE extraction ─────────────────────────────────
  const proposedId = existing?.id ?? uuidv4();

  db.prepare(`
    INSERT INTO files (id, path, name, type, subject, size, mtime_ms, content_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      name         = excluded.name,
      type         = excluded.type,
      subject      = excluded.subject,
      size         = excluded.size,
      mtime_ms     = excluded.mtime_ms,
      content_hash = excluded.content_hash,
      indexed_at   = NULL
  `).run(
    proposedId,
    filePath,
    path.basename(filePath),
    fileType,
    subject,
    stat.size,
    mtimeMs,
    contentHash,
  );

  const fileId = (db.prepare('SELECT id FROM files WHERE path = ?').get(filePath) as { id: string }).id;

  // ── Extract text ─────────────────────────────────────────────────────────
  try { writeLog('indexer:start', `${path.basename(filePath)} size:${Math.round(stat.size / 1024)}kb`); } catch { /* ignore */ }
  console.log(`[indexer] Starting: ${path.basename(filePath)}`);
  const pages = await extractPages(filePath, fileType, raw, (currentPage, totalPages) => {
    emitProgress(fileId, 0, undefined, currentPage, totalPages, path.basename(filePath));
  });
  if (pages.length === 0) {
    try { writeLog('indexer:skip', `${path.basename(filePath)} no extractable text`); } catch { /* ignore */ }
    db.prepare("UPDATE files SET indexed_at = unixepoch() WHERE id = ?").run(fileId);
    return;
  }
  const totalWords = pages.reduce((sum, p) => sum + p.text.split(/\s+/).length, 0);
  try { writeLog('indexer:extract', `${pages.length} pages ${totalWords} words`, true); } catch { /* ignore */ }
  console.log(`[indexer] Extracted ${pages.length} pages, chunking: ${path.basename(filePath)}`);

  // ── Prepared statements for batch writes ─────────────────────────────────
  const insertChunk = db.prepare(`
    INSERT INTO chunks (id, file_id, page_or_slide, text, chunk_index, is_annotation, text_hash)
    VALUES (?, ?, ?, ?, ?, 0, ?)
  `);
  const insertFts = db.prepare(`
    INSERT INTO chunks_fts(rowid, text, file_id, page_or_slide)
    SELECT rowid, text, file_id, page_or_slide FROM chunks WHERE id = ?
  `);
  const insertCache = db.prepare(
    'INSERT OR REPLACE INTO embed_cache(text_hash, vector, model) VALUES(?,?,?)'
  );

  const insertChunkBatch = db.transaction((chunks: typeof pendingBatch) => {
    for (const c of chunks) {
      insertChunk.run(c.id, c.file_id, c.page_or_slide, c.text, c.chunk_index, c.text_hash);
      insertFts.run(c.id);
    }
  });

  type ChunkRow = {
    id: string; file_id: string; page_or_slide: number; text: string;
    chunk_index: number; embed_text: string; text_hash: string;
  };

  let pendingBatch: ChunkRow[] = [];
  let totalChunks = 0;
  let embeddedChunks = 0;
  let batchNum = 0;
  let hitCap = false;

  const flushBatch = async (batch: ChunkRow[]) => {
    if (batch.length === 0) return;
    batchNum++;

    // ── Embedding cache check ────────────────────────────────────────────
    const toEmbed: ChunkRow[] = [];
    const cached = new Map<string, number[]>();

    for (const chunk of batch) {
      const hit = queryEmbedCache(db, chunk.text_hash);
      if (hit) {
        cached.set(chunk.id, hit);
      } else {
        toEmbed.push(chunk);
      }
    }

    // ── Embed only uncached chunks ───────────────────────────────────────
    let vectors: number[][] = [];
    if (toEmbed.length > 0) {
      const texts = toEmbed.map(c => DOC_PREFIX + c.embed_text);
      try {
        vectors = await embedChunks(texts);
      } catch (embedErr) {
        try { writeLog('indexer:ERROR', `embedChunks failed — skipping vectors for batch: ${embedErr}`); } catch { /* ignore */ }
        console.warn('[indexer] embedChunks error — skipping LanceDB write for this batch:', embedErr);
        // Still write chunks to SQLite even if embedding fails
        insertChunkBatch(batch);
        embeddedChunks += batch.length;
        return;
      }

      // Persist to embed_cache
      const cacheAll = db.transaction(() => {
        toEmbed.forEach((chunk, i) => {
          insertCache.run(chunk.text_hash, JSON.stringify(vectors[i]), MODEL_NAME);
        });
      });
      cacheAll();
    }

    // ── Write chunks to SQLite in one transaction ────────────────────────
    insertChunkBatch(batch);

    // ── Write vectors to LanceDB ─────────────────────────────────────────
    const chunksWithVecs = batch.map((chunk) => {
      const vec = cached.get(chunk.id) ?? vectors[toEmbed.indexOf(chunk)];
      return { ...chunk, is_annotation: 0, vector: vec };
    });
    await addVectors(vaultPath, chunksWithVecs);

    embeddedChunks += batch.length;
    emitProgress(fileId, embeddedChunks, totalChunks);
    console.log(`[indexer] Batch ${batchNum}: ${embeddedChunks}/${totalChunks} chunks indexed: ${path.basename(filePath)}`);
  };

  // First pass: build all chunks to know total count
  const allChunks: ChunkRow[] = [];
  for (const { page, text } of pages) {
    const pieces = chunkText(text, 300, 50);
    const headingCtx = extractHeadingContext(text);

    for (let idx = 0; idx < pieces.length; idx++) {
      const textHash = sha256(pieces[idx]);
      allChunks.push({
        id: uuidv4(),
        file_id: fileId,
        page_or_slide: page,
        text: pieces[idx],
        chunk_index: idx,
        embed_text: buildEmbedText(pieces[idx], filePath, headingCtx),
        text_hash: textHash,
      });
      if (allChunks.length >= MAX_CHUNKS_PER_FILE) { hitCap = true; break; }
    }
    if (hitCap) {
      console.log(`[indexer] Chunk cap (${MAX_CHUNKS_PER_FILE}) reached at page ${page}/${pages.length}: ${path.basename(filePath)}`);
      break;
    }
  }
  totalChunks = allChunks.length;
  try { writeLog('indexer:chunks', `${totalChunks} chunks`, true); } catch { /* ignore */ }
  console.log(`[indexer] ${totalChunks} chunks to index: ${path.basename(filePath)}`);

  // Second pass: process in batches — store + embed + write vectors per batch
  for (let i = 0; i < allChunks.length; i += EMBED_SUB_BATCH) {
    const batch = allChunks.slice(i, i + EMBED_SUB_BATCH);
    await flushBatch(batch);
  }

  console.log(`[indexer] Done: ${path.basename(filePath)}`);
  try { writeLog('indexer:done', `${path.basename(filePath)} complete`); } catch { /* ignore */ }

  // ── Mark as indexed ──────────────────────────────────────────────────────
  db.prepare("UPDATE files SET indexed_at = unixepoch() WHERE id = ?").run(fileId);
}

/**
 * Remove all chunks, FTS rows, and vectors for a file ID.
 * FTS5 content-sync tables require the special 'delete' command with original
 * row values — a plain DELETE statement corrupts the index.
 */
export async function purgeFile(
  fileId: string,
  vaultPath: string,
  db: ReturnType<typeof getDb>,
): Promise<void> {
  // Fetch chunk data needed for proper FTS5 content-sync removal
  const chunks = db.prepare(
    'SELECT rowid, text, file_id, page_or_slide FROM chunks WHERE file_id = ?'
  ).all(fileId) as Array<{ rowid: number; text: string; file_id: string; page_or_slide: number | null }>;

  // Issue the proper FTS5 delete command for each chunk
  const deleteFts = db.prepare(
    "INSERT INTO chunks_fts(chunks_fts, rowid, text, file_id, page_or_slide) VALUES('delete', ?, ?, ?, ?)"
  );
  const purgeTransaction = db.transaction(() => {
    for (const c of chunks) {
      deleteFts.run(c.rowid, c.text, c.file_id, c.page_or_slide);
    }
    // Delete chunks explicitly, then the file record
    db.prepare('DELETE FROM chunks WHERE file_id = ?').run(fileId);
    db.prepare('DELETE FROM files WHERE id = ?').run(fileId);
  });

  try {
    purgeTransaction();
  } catch (err) {
    // If FTS5 delete failed (e.g. pre-existing corruption), fall back to
    // rebuilding the entire FTS index so search keeps working.
    console.warn('[purge] Transaction failed, rebuilding FTS5 index:', err);
    db.prepare('DELETE FROM chunks WHERE file_id = ?').run(fileId);
    db.prepare('DELETE FROM files WHERE id = ?').run(fileId);
    try {
      db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')");
    } catch (rebuildErr) {
      console.error('[purge] FTS5 rebuild failed:', rebuildErr);
    }
  }

  await deleteVectorsByFileId(vaultPath, fileId);
}

// ── Text extraction ──────────────────────────────────────────────────────────

type PageText = { page: number; text: string };

async function extractPages(
  filePath: string,
  fileType: SupportedType,
  raw: Buffer,
  onPageProgress?: (currentPage: number, totalPages: number) => void,
): Promise<PageText[]> {
  switch (fileType) {
    case 'md':
    case 'txt':
      return [{ page: 1, text: raw.toString('utf-8') }];

    case 'pdf': {
      if (!ENABLE_PDF_INDEXING) return [];
      return extractPdfPages(filePath, raw, onPageProgress);
    }

    case 'pptx': {
      if (!ENABLE_PPTX_INDEXING) return [];
      const officeParserModule = await import('officeparser');
      const text: string = await new Promise((resolve, reject) => {
        (officeParserModule.default ?? officeParserModule as { parseOffice: (p: string, cb: (d: string | undefined, e: unknown) => void) => void })
          .parseOffice(filePath, (data: string | undefined, err: unknown) => {
            if (err) { reject(err); return; }
            resolve(data ?? '');
          });
      });
      return typeof text === 'string' ? [{ page: 1, text }] : [];
    }

    default:
      return [];
  }
}

// ── PDF extraction worker code (runs in a separate thread) ───────────────────
const PDF_WORKER_CODE = String.raw`
'use strict';
const { parentPort, workerData } = require('worker_threads');
const { createRequire } = require('module');
const { pathToFileURL } = require('url');
const fs = require('fs');

(async () => {
  try {
    const localRequire = createRequire(workerData.resolveDir + '/package.json');
    const pdfjsPath = localRequire.resolve('pdfjs-dist/legacy/build/pdf.mjs');
    const pdfjsLib = await import(pathToFileURL(pdfjsPath).href);

    const raw = fs.readFileSync(workerData.filePath);
    const uint8 = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    const cfg = workerData.config;

    let pdfWorker = null;
    let doc = null;
    try {
      pdfWorker = new pdfjsLib.PDFWorker({ port: null });
      doc = await pdfjsLib.getDocument({
        data: uint8,
        worker: pdfWorker,
        useSystemFonts: true,
        isEvalSupported: false,
      }).promise;

      const totalPages = doc.numPages;

      // Sample probe
      let sampleTextPages = 0;
      const sampleEnd = Math.min(cfg.samplePages, totalPages);
      for (let s = 1; s <= sampleEnd; s++) {
        const sample = await Promise.race([
          (async () => {
            const pg = await doc.getPage(s);
            const tc = await pg.getTextContent();
            return tc.items.map(function(it) { return (it && it.str) || ''; }).join(' ').trim();
          })(),
          new Promise(function(r) { setTimeout(function() { r(null); }, cfg.sampleTimeoutMs); }),
        ]).catch(function() { return null; });
        if (sample !== null && sample.split(/\s+/).filter(Boolean).length >= cfg.minWordsPerPage) {
          sampleTextPages++;
        }
      }

      if (sampleTextPages === 0) {
        parentPort.postMessage({ type: 'done', pages: [], skipped: true });
        return;
      }

      const pages = [];
      let consecutiveTimeouts = 0;
      const PAGE_BATCH_SIZE = 4;
      let abortExtraction = false;

      for (let batchStart = 1; batchStart <= totalPages && !abortExtraction; batchStart += PAGE_BATCH_SIZE) {
        const batchEnd = Math.min(batchStart + PAGE_BATCH_SIZE - 1, totalPages);
        const batchIndices = [];
        for (let i = batchStart; i <= batchEnd; i++) batchIndices.push(i);

        const batchResults = await Promise.all(batchIndices.map(function(i) {
          return Promise.race([
            (async () => {
              const pg = await doc.getPage(i);
              const tc = await pg.getTextContent();
              const text = tc.items.map(function(it) { return (it && it.str) || ''; }).join(' ').trim();
              return { page: i, text: text, timedOut: false };
            })(),
            new Promise(function(r) { setTimeout(function() { r({ page: i, text: null, timedOut: true }); }, cfg.perPageTimeoutMs); }),
          ]).catch(function() { return { page: i, text: null, timedOut: false }; });
        }));

        for (const result of batchResults) {
          if (result.text === null) {
            if (result.timedOut) {
              consecutiveTimeouts++;
              if (consecutiveTimeouts >= cfg.maxConsecutiveTimeouts) { abortExtraction = true; break; }
            }
            continue;
          }

          consecutiveTimeouts = 0;
          const wordCount = result.text.split(/\s+/).filter(Boolean).length;
          if (wordCount < cfg.minWordsPerPage) continue;

          pages.push({ page: result.page, text: result.text });
        }

        // Report page progress back to main thread
        parentPort.postMessage({ type: 'pageProgress', currentPage: batchEnd, totalPages: totalPages });
      }

      parentPort.postMessage({ type: 'done', pages: pages });
    } finally {
      try { if (doc) doc.destroy(); } catch (e) {}
      try { if (pdfWorker) pdfWorker.destroy(); } catch (e) {}
    }
  } catch (err) {
    parentPort.postMessage({ type: 'error', error: String((err && err.message) || err) });
  }
})();
`;

/**
 * Extract text from a PDF in a worker thread so the main process stays responsive.
 *
 * Uses resourceLimits to prevent a misbehaving PDF from OOM-killing the whole
 * Electron process, and an overall timeout so corrupted files don't hang forever.
 */
const PDF_OVERALL_TIMEOUT_MS = 120_000; // 2 min max per PDF

async function extractPdfPages(filePath: string, _raw: Buffer, onPageProgress?: (currentPage: number, totalPages: number) => void): Promise<PageText[]> {
  return new Promise<PageText[]>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const w = new Worker(PDF_WORKER_CODE, {
      eval: true,
      workerData: {
        filePath,
        resolveDir: __dirname,
        config: {
          perPageTimeoutMs: PDF_PER_PAGE_TIMEOUT_MS,
          minWordsPerPage: PDF_MIN_WORDS_PER_PAGE,
          samplePages: PDF_SAMPLE_PAGES,
          sampleTimeoutMs: PDF_SAMPLE_TIMEOUT_MS,
          maxConsecutiveTimeouts: PDF_MAX_CONSECUTIVE_TIMEOUTS,
        },
      },
      // Isolate the worker's heap so a bad PDF can't OOM the main process
      resourceLimits: {
        maxOldGenerationSizeMb: 512,
        maxYoungGenerationSizeMb: 64,
        stackSizeMb: 8,
      },
    });

    function settle(result: PageText[] | Error) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { w.terminate(); } catch { /* ignore */ }
      if (result instanceof Error) reject(result);
      else resolve(result);
    }

    // Kill the worker if the whole extraction takes too long
    timer = setTimeout(() => {
      try { writeLog('indexer:ERROR', `PDF extraction timed out after ${PDF_OVERALL_TIMEOUT_MS / 1000}s: ${path.basename(filePath)}`); } catch { /* ignore */ }
      settle(new Error(`PDF extraction timed out for ${path.basename(filePath)}`));
    }, PDF_OVERALL_TIMEOUT_MS);

    w.on('message', (msg: { type: string; pages?: PageText[]; error?: string; skipped?: boolean; currentPage?: number; totalPages?: number }) => {
      if (msg.type === 'pageProgress') {
        if (onPageProgress && msg.currentPage != null && msg.totalPages != null) {
          onPageProgress(msg.currentPage, msg.totalPages);
        }
        return;
      }
      if (msg.type === 'error') {
        try { writeLog('indexer:ERROR', `PDF worker error: ${msg.error} file:${path.basename(filePath)}`); } catch { /* ignore */ }
        settle(new Error(msg.error));
      } else {
        if (msg.skipped) {
          console.log(`[indexer] Skipping image-only/unreadable PDF: ${filePath}`);
        }
        settle(msg.pages ?? []);
      }
    });

    w.on('error', (err) => {
      if (settled) return;
      try { writeLog('indexer:ERROR', `PDF worker crashed: ${err instanceof Error ? err.message : String(err)} file:${path.basename(filePath)}`); } catch { /* ignore */ }
      settle(err instanceof Error ? err : new Error(String(err)));
    });

    w.on('exit', (code) => {
      if (settled) return; // w.terminate() after success causes code 1 — not an error
      if (code !== 0) {
        try { writeLog('indexer:ERROR', `PDF worker exited code:${code} file:${path.basename(filePath)}`); } catch { /* ignore */ }
      }
      settle(code !== 0 ? new Error(`PDF worker exited with code ${code}`) : []);
    });
  });
}

// ── Contextual embedding helpers ─────────────────────────────────────────────

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
  const text = charOffset != null ? pageText.slice(0, charOffset) : pageText;
  const lines = text.split('\n');
  const last = [...lines].reverse().find(
    l => /^#{1,6}\s/.test(l) || /^[A-Z\s]{6,}$/.test(l.trim())
  );
  return last ? last.replace(/^#+\s*/, '').trim() : '';
}

// ── Progress reporting ───────────────────────────────────────────────────────

function emitProgress(
  fileId: string,
  chunksProcessed: number,
  totalChunks?: number,
  currentPage?: number,
  totalPages?: number,
  fileName?: string,
) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('vault:indexProgress', {
      fileId,
      chunksProcessed,
      totalChunks: totalChunks ?? null,
      timestamp: Date.now(),
      currentPage: currentPage ?? null,
      totalPages: totalPages ?? null,
      currentFile: fileName ?? null,
    });
  }
}

// ── Chunking utility ─────────────────────────────────────────────────────────

/**
 * Naïve whitespace-token chunker.
 * Splits text into overlapping windows of `maxTokens` words with `overlap` words
 * of context from the previous chunk.
 */
export function chunkText(text: string, maxTokens = 300, overlap = 50): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const chunks: string[] = [];
  let start = 0;

  while (start < words.length) {
    const end = Math.min(start + maxTokens, words.length);
    chunks.push(words.slice(start, end).join(' '));
    if (end === words.length) break;
    start += maxTokens - overlap;
  }

  return chunks;
}
