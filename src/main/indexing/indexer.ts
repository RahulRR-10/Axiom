import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { v4 as uuidv4 } from 'uuid';

import { embedBatch } from '../workers/embedder';
import { addVectors, deleteVectorsByFileId } from '../database/vectorStore';
import { getDb } from '../database/schema';

// ── Feature flags (vertical-slice gate: Phase 2.9) ───────────────────────────
export const ENABLE_PDF_INDEXING = true;
export const ENABLE_PPTX_INDEXING = false;

// ── Safety limits ────────────────────────────────────────────────────────────
const EXTRACT_TIMEOUT_MS = 30_000;      // 30 s per file
const EMBED_SUB_BATCH = 32;             // chunks sent to embedder at a time
const PDF_PER_PAGE_TIMEOUT_MS = 5_000;  // 5 s per page — skip if it hangs
const PDF_MIN_WORDS_PER_PAGE = 3;       // pages with fewer words are image-only / blank
const PDF_SAMPLE_PAGES = 5;             // pages to probe before committing to full extraction
const PDF_SAMPLE_TIMEOUT_MS = 1_500;    // tight timeout used only during the sample probe

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
  const pages = await extractPages(filePath, fileType, raw);
  if (pages.length === 0) return;

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

  // ── Chunk text and insert into SQLite ────────────────────────────────────
  const allChunks: Array<{ id: string; file_id: string; page_or_slide: number; text: string; chunk_index: number }> = [];

  for (const { page, text } of pages) {
    const pieces = chunkText(text, 300, 50);
    pieces.forEach((piece, idx) => {
      allChunks.push({
        id: uuidv4(),
        file_id: fileId,
        page_or_slide: page,
        text: piece,
        chunk_index: idx,
      });
    });
  }

  const insertChunk = db.prepare(`
    INSERT INTO chunks (id, file_id, page_or_slide, text, chunk_index, is_annotation)
    VALUES (?, ?, ?, ?, ?, 0)
  `);

  const insertAllChunks = db.transaction(() => {
    for (const c of allChunks) {
      insertChunk.run(c.id, c.file_id, c.page_or_slide, c.text, c.chunk_index);
    }
  });
  insertAllChunks();

  // ── Populate FTS5 table ──────────────────────────────────────────────────
  db.prepare(`
    INSERT INTO chunks_fts(rowid, text, file_id, page_or_slide)
    SELECT rowid, text, file_id, page_or_slide FROM chunks WHERE file_id = ?
  `).run(fileId);

  // ── Generate embeddings and upsert vectors (in sub-batches to cap memory) ─
  const vectors: number[][] = [];
  for (let i = 0; i < allChunks.length; i += EMBED_SUB_BATCH) {
    const batchTexts = allChunks.slice(i, i + EMBED_SUB_BATCH).map((c) => c.text);
    const batchVecs = await embedBatch(batchTexts);
    vectors.push(...batchVecs);
    // Yield to event loop between sub-batches
    if (i + EMBED_SUB_BATCH < allChunks.length) await new Promise((r) => setTimeout(r, 0));
  }

  const chunksWithVecs = allChunks.map((c, i) => ({
    ...c,
    is_annotation: 0,
    vector: vectors[i],
  }));

  await addVectors(vaultPath, chunksWithVecs);

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

      // Race against a timeout so a corrupted / huge PDF can't stall forever
      return Promise.race([
        extractPdfPages(filePath, raw),
        rejectAfterTimeout(EXTRACT_TIMEOUT_MS, filePath),
      ]);
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

/** Extract text from a PDF, page by page. */
async function extractPdfPages(filePath: string, raw: Buffer): Promise<PageText[]> {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const uint8 = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);

  let worker: any = null;
  let doc: any = null;
  try {
    worker = new pdfjsLib.PDFWorker({ port: null });
    doc = await pdfjsLib.getDocument({
      data: uint8,
      worker,
      useSystemFonts: true,
      isEvalSupported: false,
    }).promise;

    const totalPages: number = doc.numPages;

    // ── Sample probe: quickly check a few pages with a tight timeout ─────────
    // If a scanned/image PDF causes pdfjs to hang on every page, this lets us
    // detect it upfront and bail before spending minutes on each page.
    let sampleTextPages = 0;
    const sampleEnd = Math.min(PDF_SAMPLE_PAGES, totalPages);
    for (let s = 1; s <= sampleEnd; s++) {
      const sample = await Promise.race([
        (async () => {
          const page = await doc.getPage(s);
          const tc = await page.getTextContent();
          return tc.items.map((item: any) => (item?.str ?? '')).join(' ').trim();
        })(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), PDF_SAMPLE_TIMEOUT_MS)),
      ]).catch(() => null);
      if (sample !== null && sample.split(/\s+/).filter(Boolean).length >= PDF_MIN_WORDS_PER_PAGE) {
        sampleTextPages++;
      }
    }
    if (sampleTextPages === 0) {
      console.log(`[indexer] Skipping image-only/unreadable PDF (0/${sampleEnd} sample pages had text): ${filePath}`);
      return [];
    }

    const pages: PageText[] = [];
    for (let i = 1; i <= totalPages; i++) {
      try {
        // Per-page timeout: skip pages that hang (complex vector art, corrupt streams)
        const text = await Promise.race([
          (async () => {
            const page = await doc.getPage(i);
            const tc = await page.getTextContent();
            return tc.items
              .map((item: any) => (item?.str ?? ''))
              .join(' ')
              .trim();
          })(),
          new Promise<null>((resolve) =>
            setTimeout(() => {
              console.warn(`[indexer] Page ${i} timed out (${PDF_PER_PAGE_TIMEOUT_MS}ms), skipping: ${filePath}`);
              resolve(null);
            }, PDF_PER_PAGE_TIMEOUT_MS),
          ),
        ]);

        if (text === null) continue; // timed out

        // Skip image-only / blank pages (too few words to be useful)
        const wordCount = text.split(/\s+/).filter(Boolean).length;
        if (wordCount < PDF_MIN_WORDS_PER_PAGE) continue;

        pages.push({ page: i, text });
      } catch (pageErr) {
        console.warn(`[indexer] Skipping page ${i} of ${filePath}:`, pageErr);
      }
      // Yield to event loop every 10 pages so the main process stays responsive
      if (i % 10 === 0) await new Promise((r) => setTimeout(r, 0));
    }

    return pages;
  } catch (err) {
    console.error(`[indexer] PDF extraction failed for ${filePath}:`, err);
    return [];
  } finally {
    try { doc?.destroy(); } catch { /* ignore */ }
    try { worker?.destroy(); } catch { /* ignore */ }
  }
}

/** Returns a promise that rejects after `ms` milliseconds — used with Promise.race. */
function rejectAfterTimeout(ms: number, filePath: string): Promise<never> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error(`[indexer] Timed out after ${ms}ms: ${filePath}`)), ms);
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
