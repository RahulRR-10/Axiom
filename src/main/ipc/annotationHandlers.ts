import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { BrowserWindow, ipcMain } from 'electron';
import { v4 as uuidv4 } from 'uuid';

import { ANNOTATION_CHANNELS } from '../../shared/ipc/channels';
import type { Annotation } from '../../shared/types';
import { getDb } from '../database/schema';
import { embedBatch } from '../workers/embedder';
import { addVectors, deleteVectorsByIds } from '../database/vectorStore';
import { suppressPath, unsuppressPath } from '../vault/vaultWatcher';
import { writeLog } from '../logger';

export function registerAnnotationHandlers(): void {

  // ── annotation:save ────────────────────────────────────────────────────────
  ipcMain.handle(
    ANNOTATION_CHANNELS.SAVE,
    async (event, vaultPath: string, annotation: Annotation) => {      try { writeLog('IPC:received', 'annotation:save'); } catch { /* ignore */ }
      const db = getDb(vaultPath);
      const id = annotation.id ?? uuidv4();

      db.prepare(`
        INSERT OR REPLACE INTO annotations
          (id, file_id, page, type, data_json, created_at)
        VALUES (?, ?, ?, ?, ?, COALESCE(
          (SELECT created_at FROM annotations WHERE id = ?),
          unixepoch()
        ))
      `).run(
        id,
        annotation.file_id,
        annotation.page,
        annotation.type,
        JSON.stringify(annotation),
        id,
      );

      // Broadcast to other windows so other viewers refresh
      // Resolve file_id → filePath so the sync key is always a normalized path
      const fileRow = db.prepare('SELECT path FROM files WHERE id = ?').get(annotation.file_id) as { path: string } | undefined;
      const syncPath = fileRow ? path.normalize(fileRow.path).toLowerCase() : annotation.file_id;
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.webContents.id !== event.sender.id) {
          win.webContents.send('annotations:saved', syncPath);
        }
      }

      return { id };
    },
  );

  // ── annotation:load ────────────────────────────────────────────────────────
  ipcMain.handle(
    ANNOTATION_CHANNELS.LOAD,
    async (_event, vaultPath: string, fileId: string) => {
      const db = getDb(vaultPath);
      const rows = db.prepare(
        'SELECT data_json FROM annotations WHERE file_id = ? ORDER BY page, created_at',
      ).all(fileId) as Array<{ data_json: string }>;

      return rows.map(r => JSON.parse(r.data_json) as Annotation);
    },
  );

  // ── annotation:delete ──────────────────────────────────────────────────────
  ipcMain.handle(
    ANNOTATION_CHANNELS.DELETE,
    async (_event, vaultPath: string, annotationId: string) => {
      const db = getDb(vaultPath);
      db.prepare('DELETE FROM annotations WHERE id = ?').run(annotationId);
      return { ok: true };
    },
  );

  // ── annotation:reindexPdf ──────────────────────────────────────────────────
  // Updates annotation-text chunks (sticky/textbox content) without
  // re-extracting the full PDF body text.  Body-text chunks stay untouched;
  // only is_annotation=1 rows are purged and rebuilt.
  ipcMain.handle(
    ANNOTATION_CHANNELS.REINDEX_PDF,
    async (_event, vaultPath: string, filePath: string, fileId: string) => {      try { writeLog('IPC:received', 'annotation:reindexPdf'); } catch { /* ignore */ }
      try {
      // Suppress the watcher so the on-disk write (baked annotations) doesn't
      // trigger a redundant full indexFile() for this PDF (or siblings on Windows).
      suppressPath(filePath);

      const db = getDb(vaultPath);

      // 1. Update the file record's mtime + hash so future watcher events
      //    see the file as "unchanged" and skip it.
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        const raw = fs.readFileSync(filePath);
        const contentHash = crypto.createHash('sha256').update(raw).digest('hex');
        db.prepare(
          'UPDATE files SET mtime_ms = ?, content_hash = ?, size = ? WHERE id = ?',
        ).run(stat.mtimeMs, contentHash, stat.size, fileId);
      }

      // 2. Purge old annotation chunks (FTS5 + SQLite + LanceDB)
      const oldChunks = db.prepare(
        'SELECT rowid, id, text, file_id, page_or_slide FROM chunks WHERE file_id = ? AND is_annotation = 1',
      ).all(fileId) as Array<{ rowid: number; id: string; text: string; file_id: string; page_or_slide: number | null }>;

      if (oldChunks.length > 0) {
        const deleteFts = db.prepare(
          "INSERT INTO chunks_fts(chunks_fts, rowid, text, file_id, page_or_slide) VALUES('delete', ?, ?, ?, ?)",
        );
        const purge = db.transaction(() => {
          for (const c of oldChunks) {
            deleteFts.run(c.rowid, c.text, c.file_id, c.page_or_slide);
          }
          db.prepare('DELETE FROM chunks WHERE file_id = ? AND is_annotation = 1').run(fileId);
        });
        purge();

        await deleteVectorsByIds(vaultPath, oldChunks.map(c => c.id));
      }

      // 3. Load all annotations for this file
      const rows = db.prepare(
        'SELECT data_json FROM annotations WHERE file_id = ? ORDER BY page, created_at',
      ).all(fileId) as Array<{ data_json: string }>;

      const annotations = rows.map(r => JSON.parse(r.data_json) as Annotation);

      // 4. Collect text from sticky and textbox annotations
      const annotationChunks: Array<{
        id: string; file_id: string; page_or_slide: number;
        text: string; chunk_index: number;
      }> = [];

      let chunkIdx = 0;
      for (const ann of annotations) {
        if ((ann.type === 'sticky' || ann.type === 'textbox') && ann.content?.trim()) {
          annotationChunks.push({
            id: uuidv4(),
            file_id: fileId,
            page_or_slide: ann.page,
            text: ann.content.trim(),
            chunk_index: chunkIdx++,
          });
        }
      }

      if (annotationChunks.length === 0) {
        // Unsuppress after a delay so the watcher's pending event is ignored
        setTimeout(() => unsuppressPath(filePath), 2000);
        return { ok: true };
      }

      // 5. Insert annotation chunks into SQLite
      const insertChunk = db.prepare(`
        INSERT INTO chunks (id, file_id, page_or_slide, text, chunk_index, is_annotation)
        VALUES (?, ?, ?, ?, ?, 1)
      `);

      const insertAll = db.transaction(() => {
        for (const c of annotationChunks) {
          insertChunk.run(c.id, c.file_id, c.page_or_slide, c.text, c.chunk_index);
        }
      });
      insertAll();

      // 6. Populate FTS5 for annotation chunks
      for (const c of annotationChunks) {
        db.prepare(`
          INSERT INTO chunks_fts(rowid, text, file_id, page_or_slide)
          SELECT rowid, text, file_id, page_or_slide FROM chunks WHERE id = ?
        `).run(c.id);
      }

      // 7. Generate embeddings and add to vector store
      const texts = annotationChunks.map(c => c.text);
      const vectors = await embedBatch(texts);

      const chunksWithVecs = annotationChunks.map((c, i) => ({
        ...c,
        is_annotation: 1,
        vector: vectors[i],
      }));

      await addVectors(vaultPath, chunksWithVecs);

      // Unsuppress after a delay so the watcher's pending event is ignored
      setTimeout(() => unsuppressPath(filePath), 2000);

      return { ok: true };
      } catch (err) {
        // Ensure we unsuppress even on error
        setTimeout(() => unsuppressPath(filePath), 2000);
        try { writeLog('IPC:ERROR', `channel:annotation:reindexPdf error:${err instanceof Error ? err.message : String(err)}`); } catch { /* ignore */ }
        throw err;
      }
    },
  );
}

