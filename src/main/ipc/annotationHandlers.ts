import * as path from 'path';

import { BrowserWindow, ipcMain } from 'electron';
import { v4 as uuidv4 } from 'uuid';

import { ANNOTATION_CHANNELS } from '../../shared/ipc/channels';
import type { Annotation } from '../../shared/types';
import { getDb } from '../database/schema';
import { indexFile } from '../indexing/indexer';
import { embedBatch } from '../workers/embedder';
import { addVectors } from '../database/vectorStore';
import { writeLog } from '../logger';

export function registerAnnotationHandlers(): void {

  // ── annotation:save ────────────────────────────────────────────────────────
  ipcMain.handle(
    ANNOTATION_CHANNELS.SAVE,
    async (event, vaultPath: string, annotation: Annotation) => {      try { writeLog('IPC:received', 'annotation:save'); } catch { /* ignore */ }
      try {      const db = getDb(vaultPath);
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
  // Re-indexes the PDF's own text AND inserts annotation text (sticky/textbox
  // content) as searchable chunks with is_annotation = 1.
  ipcMain.handle(
    ANNOTATION_CHANNELS.REINDEX_PDF,
    async (_event, vaultPath: string, filePath: string, fileId: string) => {      try { writeLog('IPC:received', 'annotation:reindexPdf'); } catch { /* ignore */ }
      try {      // 1. Reindex the PDF's body text (will purge old chunks + re-extract)
      await indexFile(filePath, vaultPath);

      // 2. Load all annotations for this file
      const db = getDb(vaultPath);
      const rows = db.prepare(
        'SELECT data_json FROM annotations WHERE file_id = ? ORDER BY page, created_at',
      ).all(fileId) as Array<{ data_json: string }>;

      const annotations = rows.map(r => JSON.parse(r.data_json) as Annotation);

      // 3. Collect text from sticky and textbox annotations
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

      if (annotationChunks.length === 0) return { ok: true };

      // 4. Insert annotation chunks into SQLite
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

      // 5. Populate FTS5 for annotation chunks
      for (const c of annotationChunks) {
        db.prepare(`
          INSERT INTO chunks_fts(rowid, text, file_id, page_or_slide)
          SELECT rowid, text, file_id, page_or_slide FROM chunks WHERE id = ?
        `).run(c.id);
      }

      // 6. Generate embeddings and add to vector store
      const texts = annotationChunks.map(c => c.text);
      const vectors = await embedBatch(texts);

      const chunksWithVecs = annotationChunks.map((c, i) => ({
        ...c,
        is_annotation: 1,
        vector: vectors[i],
      }));

      await addVectors(vaultPath, chunksWithVecs);

      return { ok: true };
      } catch (err) { try { writeLog('IPC:ERROR', `channel:annotation:reindexPdf error:${err instanceof Error ? err.message : String(err)}`); } catch { /* ignore */ } throw err; }
    },
  );
}

