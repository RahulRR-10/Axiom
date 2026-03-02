import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { v4 as uuidv4 } from 'uuid';

import { embedBatch } from '../workers/embedder';
import { addVectors, deleteVectorsByFileId } from '../database/vectorStore';
import { getDb } from '../database/schema';

// ── Feature flags (vertical-slice gate: Phase 2.9) ───────────────────────────
export const ENABLE_PDF_INDEXING  = false;
export const ENABLE_PPTX_INDEXING = false;

const SUPPORTED_EXTENSIONS = new Set([
  '.md',
  '.txt',
  ...(ENABLE_PDF_INDEXING  ? ['.pdf']  : []),
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

  const fileType = ext.slice(1) as SupportedType;
  const db = getDb(vaultPath);
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
  const fileId = existing?.id ?? uuidv4();

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
    fileId,
    filePath,
    path.basename(filePath),
    fileType,
    subject,
    stat.size,
    mtimeMs,
    contentHash,
  );

  // ── Chunk text and insert into SQLite ────────────────────────────────────
  const allChunks: Array<{ id: string; file_id: string; page_or_slide: number; text: string; chunk_index: number }> = [];

  for (const { page, text } of pages) {
    const pieces = chunkText(text, 300, 50);
    pieces.forEach((piece, idx) => {
      allChunks.push({
        id:           uuidv4(),
        file_id:      fileId,
        page_or_slide: page,
        text:         piece,
        chunk_index:  idx,
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

  // ── Generate embeddings and upsert vectors ───────────────────────────────
  const texts   = allChunks.map((c) => c.text);
  const vectors = await embedBatch(texts);

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
      // Guard — should never reach here unless flag is enabled
      if (!ENABLE_PDF_INDEXING) return [];
      const pdfParseModule = await import('pdf-parse');
      // pdf-parse exports differently across module systems
      const pdfParseFn = (pdfParseModule.default ?? pdfParseModule) as unknown as
        (buf: Buffer) => Promise<{ text: string }>;
      const data = await pdfParseFn(raw);
      return [{ page: 1, text: data.text }];
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
