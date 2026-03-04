import * as fs from 'fs';
import * as path from 'path';

import { ipcMain } from 'electron';
import { v4 as uuidv4 } from 'uuid';

import { NOTES_CHANNELS } from '../../shared/ipc/channels';
import type { NoteDetail, NoteSummary } from '../../shared/types';
import { getDb } from '../database/schema';

// ── Helpers ──────────────────────────────────────────────────────────────────

function assertMd(filePath: string): void {
    if (!filePath.endsWith('.md')) {
        throw new Error('Only .md files are supported in Notes Editor');
    }
}

function assertInsideVault(vaultPath: string, targetPath: string): void {
    const resolved = path.resolve(targetPath);
    const vaultResolved = path.resolve(vaultPath);
    if (!resolved.startsWith(vaultResolved + path.sep) && resolved !== vaultResolved) {
        throw new Error('Path is outside the vault — directory traversal prevented');
    }
}

type NoteRow = {
    id: string;
    title: string;
    file_path: string | null;
    content: string;
    subject: string | null;
    source_file_id: string | null;
    source_page: number | null;
    created_at: number;
    updated_at: number;
};

function rowToSummary(row: NoteRow): NoteSummary {
    return {
        id: row.id,
        title: row.title,
        file_path: row.file_path ?? '',
        subject: row.subject,
        source_file_id: row.source_file_id,
        source_page: row.source_page,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

// ── Registry ─────────────────────────────────────────────────────────────────

export function registerNotesHandlers(): void {

    // ── notes:create ──────────────────────────────────────────────────────────
    ipcMain.handle(
        NOTES_CHANNELS.CREATE,
        async (
            _event,
            vaultPath: string,
            targetDirectory: string,
            title: string,
            sourceFileId?: string,
            sourcePage?: number,
        ) => {
            const fileName = title.endsWith('.md') ? title : `${title}.md`;
            const filePath = path.join(targetDirectory, fileName);

            assertInsideVault(vaultPath, filePath);
            assertMd(filePath);

            // Create directory if needed
            fs.mkdirSync(targetDirectory, { recursive: true });

            // Create file on disk with empty content (or front-matter if source)
            let initialContent = '';
            if (sourceFileId && sourcePage != null) {
                initialContent = `---\nsource_file_id: ${sourceFileId}\nsource_page: ${sourcePage}\n---\n\n`;
            }
            fs.writeFileSync(filePath, initialContent, 'utf-8');

            // Insert SQLite record
            const db = getDb(vaultPath);
            const id = uuidv4();
            const now = Math.floor(Date.now() / 1000);

            db.prepare(`
        INSERT INTO notes (id, title, content, file_path, subject, source_file_id, source_page, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
                id,
                title.replace(/\.md$/, ''),
                initialContent,
                filePath,
                null, // subject derived from folder
                sourceFileId ?? null,
                sourcePage ?? null,
                now,
                now,
            );

            const row = db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as NoteRow;
            return rowToSummary(row);
        },
    );

    // ── notes:read ────────────────────────────────────────────────────────────
    ipcMain.handle(
        NOTES_CHANNELS.READ,
        async (_event, vaultPath: string, noteId: string) => {
            const db = getDb(vaultPath);
            let row = db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId) as NoteRow | undefined;

            // noteId might be a files.id (from the indexer) — resolve via file_path
            if (!row) {
                const fileRow = db.prepare('SELECT path FROM files WHERE id = ?').get(noteId) as { path: string } | undefined;
                if (fileRow) {
                    row = db.prepare('SELECT * FROM notes WHERE file_path = ?').get(fileRow.path) as NoteRow | undefined;

                    // Note record doesn't exist yet — create it on the fly
                    if (!row) {
                        const content = fs.existsSync(fileRow.path)
                            ? fs.readFileSync(fileRow.path, 'utf-8')
                            : '';
                        const title = path.basename(fileRow.path, '.md');
                        const subject = path.relative(vaultPath, path.dirname(fileRow.path)).split(path.sep)[0] || null;
                        const now = Math.floor(Date.now() / 1000);
                        const newId = noteId; // reuse the files.id so the caller stays consistent
                        db.prepare(`
                            INSERT OR IGNORE INTO notes (id, title, content, file_path, subject, source_file_id, source_page, created_at, updated_at)
                            VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)
                        `).run(newId, title, content, fileRow.path, subject, now, now);
                        row = db.prepare('SELECT * FROM notes WHERE id = ?').get(newId) as NoteRow;
                    }
                }
            }

            if (!row) throw new Error(`Note ${noteId} not found`);

            // Read content from disk if file_path exists
            let content = row.content ?? '';
            if (row.file_path && fs.existsSync(row.file_path)) {
                content = fs.readFileSync(row.file_path, 'utf-8');
            }

            const detail: NoteDetail = {
                ...rowToSummary(row),
                content,
            };
            return detail;
        },
    );

    // ── notes:update ──────────────────────────────────────────────────────────
    ipcMain.handle(
        NOTES_CHANNELS.UPDATE,
        async (_event, vaultPath: string, noteId: string, content: string) => {
            const db = getDb(vaultPath);
            const row = db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId) as NoteRow | undefined;
            if (!row) throw new Error(`Note ${noteId} not found`);

            // Write to disk
            if (row.file_path) {
                assertInsideVault(vaultPath, row.file_path);
                fs.mkdirSync(path.dirname(row.file_path), { recursive: true });
                fs.writeFileSync(row.file_path, content, 'utf-8');
            }

            // Update DB
            const now = Math.floor(Date.now() / 1000);
            db.prepare('UPDATE notes SET content = ?, updated_at = ? WHERE id = ?')
                .run(content, now, noteId);
        },
    );

    // ── notes:list ────────────────────────────────────────────────────────────
    ipcMain.handle(
        NOTES_CHANNELS.LIST,
        async (_event, vaultPath: string) => {
            const db = getDb(vaultPath);
            const rows = db.prepare(
                'SELECT * FROM notes ORDER BY updated_at DESC',
            ).all() as NoteRow[];
            return rows.map(rowToSummary);
        },
    );

    // ── notes:delete ──────────────────────────────────────────────────────────
    ipcMain.handle(
        NOTES_CHANNELS.DELETE,
        async (_event, vaultPath: string, noteId: string) => {
            const db = getDb(vaultPath);
            const row = db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId) as NoteRow | undefined;
            if (!row) return { ok: false };

            // Delete file from disk
            if (row.file_path && fs.existsSync(row.file_path)) {
                assertInsideVault(vaultPath, row.file_path);
                fs.unlinkSync(row.file_path);
            }

            // Delete from DB
            db.prepare('DELETE FROM notes WHERE id = ?').run(noteId);
            return { ok: true };
        },
    );

    // ── notes:move ────────────────────────────────────────────────────────────
    ipcMain.handle(
        NOTES_CHANNELS.MOVE,
        async (_event, vaultPath: string, noteId: string, newDirectory: string) => {
            const db = getDb(vaultPath);
            const row = db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId) as NoteRow | undefined;
            if (!row || !row.file_path) throw new Error(`Note ${noteId} not found`);

            assertInsideVault(vaultPath, newDirectory);
            const fileName = path.basename(row.file_path);
            const newPath = path.join(newDirectory, fileName);
            assertInsideVault(vaultPath, newPath);

            fs.mkdirSync(newDirectory, { recursive: true });
            fs.renameSync(row.file_path, newPath);

            const now = Math.floor(Date.now() / 1000);
            db.prepare('UPDATE notes SET file_path = ?, updated_at = ? WHERE id = ?')
                .run(newPath, now, noteId);

            const updated = db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId) as NoteRow;
            return rowToSummary(updated);
        },
    );

    // ── notes:rename ──────────────────────────────────────────────────────────
    ipcMain.handle(
        NOTES_CHANNELS.RENAME,
        async (_event, vaultPath: string, noteId: string, newTitle: string) => {
            const db = getDb(vaultPath);
            const row = db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId) as NoteRow | undefined;
            if (!row || !row.file_path) throw new Error(`Note ${noteId} not found`);

            const dir = path.dirname(row.file_path);
            const newFileName = newTitle.endsWith('.md') ? newTitle : `${newTitle}.md`;
            const newPath = path.join(dir, newFileName);
            assertInsideVault(vaultPath, newPath);

            fs.renameSync(row.file_path, newPath);

            const now = Math.floor(Date.now() / 1000);
            db.prepare('UPDATE notes SET title = ?, file_path = ?, updated_at = ? WHERE id = ?')
                .run(newTitle.replace(/\.md$/, ''), newPath, now, noteId);

            const updated = db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId) as NoteRow;
            return rowToSummary(updated);
        },
    );
}
