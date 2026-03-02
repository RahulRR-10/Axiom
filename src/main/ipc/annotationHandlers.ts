import { ipcMain } from 'electron';
import { v4 as uuidv4 } from 'uuid';

import { ANNOTATION_CHANNELS } from '../../shared/ipc/channels';
import type { Annotation } from '../../shared/types';
import { getDb } from '../database/schema';

export function registerAnnotationHandlers(): void {

  // ── annotation:save ────────────────────────────────────────────────────────
  ipcMain.handle(
    ANNOTATION_CHANNELS.SAVE,
    async (_event, vaultPath: string, annotation: Annotation) => {
      const db = getDb(vaultPath);
      const id = annotation.id ?? uuidv4();

      db.prepare(`
        INSERT OR REPLACE INTO annotations
          (id, file_id, page, type, data, created_at)
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

      return { id };
    },
  );

  // ── annotation:load ────────────────────────────────────────────────────────
  ipcMain.handle(
    ANNOTATION_CHANNELS.LOAD,
    async (_event, vaultPath: string, fileId: string) => {
      const db = getDb(vaultPath);
      const rows = db.prepare(
        'SELECT data FROM annotations WHERE file_id = ? ORDER BY page, created_at',
      ).all(fileId) as Array<{ data: string }>;

      return rows.map(r => JSON.parse(r.data) as Annotation);
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
}
