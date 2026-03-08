import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { v4 as uuidv4 } from 'uuid';
import { Worker } from 'worker_threads';

import { embedBatch } from '../workers/embedder';
import { addVectors, deleteVectorsByFileId } from '../database/vectorStore';
import { getDb } from '../database/schema';

// ── Feature flags (vertical-slice gate: Phase 2.9) ───────────────────────────
export const ENABLE_PDF_INDEXING = true;
export const ENABLE_PPTX_INDEXING = false;

// ── Safety limits ────────────────────────────────────────────────────────────
const EMBED_SUB_BATCH = 128;            // chunks sent to embedder worker at a time
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
  if (!SUPPORTED_EXTENSIONS.has(ext)) return;

  await withFileLock(filePath, () => indexFileInner(filePath, vaultPath));
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

  // ── Extract text ─────────────────────────────────────────────────────────
  console.log(`[indexer] Starting: ${path.basename(filePath)}`);
  const pages = await extractPages(filePath, fileType, raw);
  if (pages.length === 0) return;
  console.log(`[indexer] Extracted ${pages.length} pages, chunking: ${path.basename(filePath)}`);

  // ── Determine subject from parent folder name ────────────────────────────
  const subject = path.relative(vaultPath, path.dirname(filePath)).split(path.sep)[0] || null;

  // ── Upsert file record ───────────────────────────────────────────────────
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

  // Read back actual ID — may differ from proposedId if another call
  // inserted a row for this path between our purge and upsert.
  const fileId = (db.prepare('SELECT id FROM files WHERE path = ?').get(filePath) as { id: string }).id;

  // ── Chunk, store, and embed in streaming batches ─────────────────────────
  // Chunks are processed in batches: each batch is written to SQLite+FTS,
  // then embedded in the worker thread. We await each batch before starting
  // the next to avoid queuing up work with no progress feedback, and write
  // vectors incrementally so progress is always visible.

  const insertChunk = db.prepare(`
    INSERT INTO chunks (id, file_id, page_or_slide, text, chunk_index, is_annotation)
    VALUES (?, ?, ?, ?, ?, 0)
  `);
  const insertFts = db.prepare(`
    INSERT INTO chunks_fts(rowid, text, file_id, page_or_slide)
    SELECT rowid, text, file_id, page_or_slide FROM chunks WHERE id = ?
  `);

  let pendingBatch: Array<{ id: string; file_id: string; page_or_slide: number; text: string; chunk_index: number }> = [];
  let totalChunks = 0;
  let embeddedChunks = 0;
  let batchNum = 0;
  let hitCap = false;

  const flushBatch = async () => {
    if (pendingBatch.length === 0) return;
    const batch = pendingBatch;
    pendingBatch = [];
    batchNum++;

    // Write to SQLite + FTS synchronously (fast, main-thread-only)
    db.transaction(() => {
      for (const c of batch) {
        insertChunk.run(c.id, c.file_id, c.page_or_slide, c.text, c.chunk_index);
        insertFts.run(c.id);
      }
    })();

    // Embed in worker thread and write vectors immediately
    const texts = batch.map((c) => c.text);
    const vectors = await embedBatch(texts);
    const chunksWithVecs = batch.map((c, i) => ({ ...c, is_annotation: 0, vector: vectors[i] }));
    await addVectors(vaultPath, chunksWithVecs);

    embeddedChunks += batch.length;
    console.log(`[indexer] Batch ${batchNum}: ${embeddedChunks}/${totalChunks} chunks indexed: ${path.basename(filePath)}`);
  };

  // First pass: build all chunks to know total count
  const allChunks: typeof pendingBatch = [];
  for (const { page, text } of pages) {
    const pieces = chunkText(text, 1024, 128);
    for (let idx = 0; idx < pieces.length; idx++) {
      allChunks.push({
        id: uuidv4(),
        file_id: fileId,
        page_or_slide: page,
        text: pieces[idx],
        chunk_index: idx,
      });
      if (allChunks.length >= MAX_CHUNKS_PER_FILE) { hitCap = true; break; }
    }
    if (hitCap) {
      console.log(`[indexer] Chunk cap (${MAX_CHUNKS_PER_FILE}) reached at page ${page}/${pages.length}: ${path.basename(filePath)}`);
      break;
    }
  }
  totalChunks = allChunks.length;
  console.log(`[indexer] ${totalChunks} chunks to index: ${path.basename(filePath)}`);

  // Second pass: process in batches — store + embed + write vectors per batch
  for (let i = 0; i < allChunks.length; i += EMBED_SUB_BATCH) {
    pendingBatch = allChunks.slice(i, i + EMBED_SUB_BATCH);
    await flushBatch();
  }

  console.log(`[indexer] Done: ${path.basename(filePath)}`);

  // ── Mark as indexed ──────────────────────────────────────────────────────
  db.prepare("UPDATE files SET indexed_at = unixepoch() WHERE id = ?").run(fileId);
}

/**
 * Remove all chunks, FTS rows, and vectors for a file ID (cascade handles
 * chunks deletion; we manually clean FTS and vectors).
 */
export async function purgeFile(
  fileId: string,
  vaultPath: string,
  db: ReturnType<typeof getDb>,
): Promise<void> {
  db.prepare("DELETE FROM chunks_fts WHERE file_id = ?").run(fileId);
  db.prepare("DELETE FROM files WHERE id = ?").run(fileId);
  await deleteVectorsByFileId(vaultPath, fileId);
}

// ── Text extraction ──────────────────────────────────────────────────────────

type PageText = { page: number; text: string };

async function extractPages(
  filePath: string,
  fileType: SupportedType,
  raw: Buffer,
): Promise<PageText[]> {
  switch (fileType) {
    case 'md':
    case 'txt':
      return [{ page: 1, text: raw.toString('utf-8') }];

    case 'pdf': {
      if (!ENABLE_PDF_INDEXING) return [];
      return extractPdfPages(filePath, raw);
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
      for (let i = 1; i <= totalPages; i++) {
        try {
          const text = await Promise.race([
            (async () => {
              const pg = await doc.getPage(i);
              const tc = await pg.getTextContent();
              return tc.items.map(function(it) { return (it && it.str) || ''; }).join(' ').trim();
            })(),
            new Promise(function(r) { setTimeout(function() { r(null); }, cfg.perPageTimeoutMs); }),
          ]);

          if (text === null) {
            consecutiveTimeouts++;
            if (consecutiveTimeouts >= cfg.maxConsecutiveTimeouts) break;
            continue;
          }

          consecutiveTimeouts = 0;
          const wordCount = text.split(/\s+/).filter(Boolean).length;
          if (wordCount < cfg.minWordsPerPage) continue;

          pages.push({ page: i, text: text });
        } catch (e) {
          // skip page
        }
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
 */
async function extractPdfPages(filePath: string, _raw: Buffer): Promise<PageText[]> {
  return new Promise<PageText[]>((resolve, reject) => {
    let settled = false;

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
    });

    w.on('message', (msg: { type: string; pages?: PageText[]; error?: string; skipped?: boolean }) => {
      if (settled) return;
      settled = true;
      if (msg.type === 'error') {
        reject(new Error(msg.error));
      } else {
        if (msg.skipped) {
          console.log(`[indexer] Skipping image-only/unreadable PDF: ${filePath}`);
        }
        resolve(msg.pages ?? []);
      }
      w.terminate();
    });

    w.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });

    w.on('exit', (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0) reject(new Error(`PDF worker exited with code ${code}`));
      else resolve([]);
    });
  });
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
