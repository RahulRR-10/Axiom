import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { BrowserWindow, ipcMain } from 'electron';
import { v4 as uuidv4 } from 'uuid';

import { NOTES_CHANNELS } from '../../shared/ipc/channels';
import type { NoteDetail, NoteSummary } from '../../shared/types';
import { getDb } from '../database/schema';
import { indexFile } from '../indexing/indexer';
import { broadcastFileChanged } from '../vault/vaultWatcher';
import { writeLog } from '../logger';

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
        ) => {            try { writeLog('IPC:received', 'notes:create'); } catch { /* ignore */ }
            try {            const fileName = title.endsWith('.md') ? title : `${title}.md`;
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
            } catch (err) { try { writeLog('IPC:ERROR', `channel:notes:create error:${err instanceof Error ? err.message : String(err)}`); } catch { /* ignore */ } throw err; }
        },
    );

    // ── notes:read ────────────────────────────────────────────────────
    ipcMain.handle(
        NOTES_CHANNELS.READ,
        async (_event, vaultPath: string, noteId: string) => {
            try { writeLog('IPC:received', 'notes:read'); } catch { /* ignore */ }
            try {
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

            // Track this as the last-used note so "Save to Note" defaults here
            try {
                db.prepare(
                    `INSERT INTO settings (key, value) VALUES ('lastUsedNoteId', ?)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
                ).run(row.id);
            } catch { /* settings table may not exist yet */ }

            const detail: NoteDetail = {
                ...rowToSummary(row),
                content,
            };
            return detail;
            } catch (err) { try { writeLog('IPC:ERROR', `channel:notes:read error:${err instanceof Error ? err.message : String(err)}`); } catch { /* ignore */ } throw err; }
        },
    );

    // ── notes:update ──────────────────────────────────────────────────
    ipcMain.handle(
        NOTES_CHANNELS.UPDATE,
        async (event, vaultPath: string, noteId: string, content: string, lastLoadedAt?: number) => {
            try { writeLog('IPC:received', 'notes:update'); } catch { /* ignore */ }
            try {
            const db = getDb(vaultPath);
            let row = db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId) as NoteRow | undefined;

            // Note record may not exist yet if readNote threw during initial load.
            // Try to find via the files table so we can still write to disk.
            if (!row) {
                const fileRow = db.prepare('SELECT path FROM files WHERE id = ?').get(noteId) as { path: string } | undefined;
                if (fileRow?.path) {
                    assertInsideVault(vaultPath, fileRow.path);
                    assertMd(fileRow.path);

                    // Conflict check: if lastLoadedAt is provided, verify mtime hasn't changed
                    if (lastLoadedAt != null && fs.existsSync(fileRow.path)) {
                        const stat = fs.statSync(fileRow.path);
                        const mtimeSec = Math.floor(stat.mtimeMs / 1000);
                        if (mtimeSec > lastLoadedAt) {
                            return { ok: false as const, reason: 'conflict' };
                        }
                    }

                    fs.mkdirSync(path.dirname(fileRow.path), { recursive: true });
                    fs.writeFileSync(fileRow.path, content, 'utf-8');
                    // Lazily create the notes record so future saves use it
                    const now = Math.floor(Date.now() / 1000);
                    const title = path.basename(fileRow.path, '.md');
                    db.prepare(`
                        INSERT OR IGNORE INTO notes (id, title, content, file_path, subject, source_file_id, source_page, created_at, updated_at)
                        VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
                    `).run(noteId, title, content, fileRow.path, now, now);
                    // Broadcast to other windows so other editors refresh
                    const normalizedPath = path.normalize(fileRow.path).toLowerCase();
                    for (const win of BrowserWindow.getAllWindows()) {
                        if (win.webContents.id !== event.sender.id) {
                            win.webContents.send('notes:saved', normalizedPath);
                        }
                    }
                    return { ok: true as const };
                }
                throw new Error(`Note ${noteId} not found`);
            }

            // Conflict check: if lastLoadedAt is provided, verify mtime hasn't changed
            if (lastLoadedAt != null && row.file_path && fs.existsSync(row.file_path)) {
                const stat = fs.statSync(row.file_path);
                const mtimeSec = Math.floor(stat.mtimeMs / 1000);
                if (mtimeSec > lastLoadedAt) {
                    return { ok: false as const, reason: 'conflict' };
                }
            }

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

            // Broadcast to other windows so other editors refresh
            const normalizedBroadcastPath = path.normalize(row.file_path ?? '').toLowerCase();
            for (const win of BrowserWindow.getAllWindows()) {
                if (win.webContents.id !== event.sender.id) {
                    win.webContents.send('notes:saved', normalizedBroadcastPath);
                }
            }

            return { ok: true as const };
            } catch (err) { try { writeLog('IPC:ERROR', `channel:notes:update error:${err instanceof Error ? err.message : String(err)}`); } catch { /* ignore */ } throw err; }
        },
    );

    // ── notes:list ────────────────────────────────────────────────────
    ipcMain.handle(
        NOTES_CHANNELS.LIST,
        async (_event, vaultPath: string) => {
            try { writeLog('IPC:received', 'notes:list'); } catch { /* ignore */ }
            try {
            const db = getDb(vaultPath);
            const noteRows = db.prepare(
                'SELECT * FROM notes ORDER BY updated_at DESC',
            ).all() as NoteRow[];

            // Also include .md files from the files table that don't have notes entries yet
            const noteFilePaths = new Set(noteRows.map(r => r.file_path).filter(Boolean));
            const mdFiles = db.prepare(
                "SELECT id, path, name, created_at FROM files WHERE type = 'md' ORDER BY name ASC",
            ).all() as Array<{ id: string; path: string; name: string; created_at: number }>;

            const extraNotes: NoteSummary[] = [];
            for (const f of mdFiles) {
                if (!noteFilePaths.has(f.path)) {
                    extraNotes.push({
                        id: f.id,
                        title: f.name.replace(/\.md$/i, ''),
                        file_path: f.path,
                        subject: null,
                        source_file_id: null,
                        source_page: null,
                        created_at: f.created_at,
                        updated_at: f.created_at,
                    });
                }
            }

            return [...noteRows.map(rowToSummary), ...extraNotes];
            } catch (err) { try { writeLog('IPC:ERROR', `channel:notes:list error:${err instanceof Error ? err.message : String(err)}`); } catch { /* ignore */ } throw err; }
        },
    );

    // ── notes:delete ──────────────────────────────────────────────────────────
    ipcMain.handle(
        NOTES_CHANNELS.DELETE,
        async (_event, vaultPath: string, noteId: string) => {
            try { writeLog('IPC:received', 'notes:delete'); } catch { /* ignore */ }
            try {
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
            } catch (err) { try { writeLog('IPC:ERROR', `channel:notes:delete error:${err instanceof Error ? err.message : String(err)}`); } catch { /* ignore */ } throw err; }
        },
    );

    // ── notes:move ────────────────────────────────────────────────────────────
    ipcMain.handle(
        NOTES_CHANNELS.MOVE,
        async (_event, vaultPath: string, noteId: string, newDirectory: string) => {
            try { writeLog('IPC:received', 'notes:move'); } catch { /* ignore */ }
            try {
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
            } catch (err) { try { writeLog('IPC:ERROR', `channel:notes:move error:${err instanceof Error ? err.message : String(err)}`); } catch { /* ignore */ } throw err; }
        },
    );

    // ── notes:rename ──────────────────────────────────────────────────────────
    ipcMain.handle(
        NOTES_CHANNELS.RENAME,
        async (_event, vaultPath: string, noteId: string, newTitle: string) => {
            try { writeLog('IPC:received', 'notes:rename'); } catch { /* ignore */ }
            try {
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
            } catch (err) { try { writeLog('IPC:ERROR', `channel:notes:rename error:${err instanceof Error ? err.message : String(err)}`); } catch { /* ignore */ } throw err; }
        },
    );

    // ── notes:exportPdf ──────────────────────────────────────────────────────────
    ipcMain.handle(
        NOTES_CHANNELS.EXPORT_PDF,
        async (_event, html: string, mdFilePath: string, vaultPath: string): Promise<string> => {
            try { writeLog('IPC:received', 'notes:exportPdf'); } catch { /* ignore */ }
            try {
            const pdfPath = mdFilePath.replace(/\.md$/i, '.pdf');

            // Write the full HTML document to a temp file so the hidden window
            // can load it via a file:// URL (avoids data: URL size limits).
            const tmpFile = path.join(os.tmpdir(), `axiom-pdf-${uuidv4()}.html`);
            fs.writeFileSync(tmpFile, html, 'utf-8');

            const win = new BrowserWindow({
                show: false,
                width: 1050,
                height: 1400,
                webPreferences: { nodeIntegration: false, contextIsolation: true },
            });

            try {
                await win.loadFile(tmpFile);
                const pdfData = await win.webContents.printToPDF({
                    printBackground: true,
                    pageSize: 'A4',
                    margins: { top: 1, bottom: 1, left: 1, right: 1 },
                });
                fs.writeFileSync(pdfPath, pdfData);

                // Index the exported PDF explicitly so it's searchable
                // immediately instead of waiting for the watcher.
                try {
                    await indexFile(pdfPath, vaultPath);
                } catch (err) {
                    console.error('[exportPdf] Failed to index exported PDF:', err);
                }

                broadcastFileChanged(vaultPath);

                return pdfPath;
            } finally {
                win.destroy();
                try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
            }
            } catch (err) { try { writeLog('IPC:ERROR', `channel:notes:exportPdf error:${err instanceof Error ? err.message : String(err)}`); } catch { /* ignore */ } throw err; }
        },
    );

    // ── notes:append ─────────────────────────────────────────────────────────
    ipcMain.handle(
        NOTES_CHANNELS.APPEND,
        async (
            _event,
            vaultPath: string,
            noteId: string,
            selectedText: string,
            sourceFile: string,
            sourcePage: number,
        ): Promise<{ ok: boolean; noteTitle?: string; reason?: string }> => {
            try { writeLog('IPC:received', 'notes:append'); } catch { /* ignore */ }
            try {
            const db = getDb(vaultPath);
            let row = db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId) as NoteRow | undefined;

            // noteId might be a files.id — resolve and create notes entry on the fly
            if (!row) {
                const fileRow = db.prepare('SELECT id, path, name FROM files WHERE id = ?').get(noteId) as { id: string; path: string; name: string } | undefined;
                if (fileRow && fileRow.path.endsWith('.md')) {
                    const content = fs.existsSync(fileRow.path) ? fs.readFileSync(fileRow.path, 'utf-8') : '';
                    const title = path.basename(fileRow.path, '.md');
                    const subject = path.relative(vaultPath, path.dirname(fileRow.path)).split(path.sep)[0] || null;
                    const now = Math.floor(Date.now() / 1000);
                    db.prepare(`
                        INSERT OR IGNORE INTO notes (id, title, content, file_path, subject, source_file_id, source_page, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)
                    `).run(noteId, title, content, fileRow.path, subject, now, now);
                    row = db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId) as NoteRow | undefined;
                }
            }

            if (!row || !row.file_path) throw new Error(`Note ${noteId} not found`);

            assertInsideVault(vaultPath, row.file_path);

            // Clean the selected text: normalize whitespace, remove hyphenation, join broken lines
            const cleaned = selectedText
                .replace(/(\w)-\n(\w)/g, '$1$2')   // join hyphenated line breaks
                .replace(/\n+/g, ' ')               // join broken lines
                .replace(/\s+/g, ' ')               // normalize whitespace
                .trim();

            // Format the block exactly per spec
            const block = `> ${cleaned}\n\n*From: ${sourceFile}, p.${sourcePage}*\n\n---\n`;

            // Read existing content and append with proper spacing
            let existing = '';
            if (fs.existsSync(row.file_path)) {
                existing = fs.readFileSync(row.file_path, 'utf-8');
            }
            // Ensure at least two newlines before the new block so it doesn't merge
            const separator = existing.length === 0 ? '' : existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
            const newContent = existing + separator + block;
            fs.writeFileSync(row.file_path, newContent, 'utf-8');

            // Update DB
            const now = Math.floor(Date.now() / 1000);
            db.prepare('UPDATE notes SET content = ?, updated_at = ? WHERE id = ?')
                .run(newContent, now, noteId);

            // Update lastUsedNoteId
            db.prepare(
                `INSERT INTO settings (key, value) VALUES ('lastUsedNoteId', ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            ).run(noteId);

            // Broadcast to other windows (not the sender — avoids closing the note tab)
            const normalizedPath = path.normalize(row.file_path).toLowerCase();
            for (const win of BrowserWindow.getAllWindows()) {
                if (win.webContents.id !== _event.sender.id) {
                    win.webContents.send('notes:saved', normalizedPath);
                }
            }

            return { ok: true, noteTitle: row.title };
            } catch (err) { try { writeLog('IPC:ERROR', `channel:notes:append error:${err instanceof Error ? err.message : String(err)}`); } catch { /* ignore */ } throw err; }
        },
    );

    // ── notes:recent ─────────────────────────────────────────────────
    ipcMain.handle(
        NOTES_CHANNELS.RECENT,
        async (_event, vaultPath: string) => {
            try { writeLog('IPC:received', 'notes:recent'); } catch { /* ignore */ }
            try {
            const db = getDb(vaultPath);
            const rows = db.prepare(
                'SELECT * FROM notes ORDER BY updated_at DESC LIMIT 5',
            ).all() as NoteRow[];

            const lastUsedRow = db.prepare(
                "SELECT value FROM settings WHERE key = 'lastUsedNoteId'",
            ).get() as { value: string } | undefined;

            return {
                notes: rows.map(rowToSummary),
                lastUsedNoteId: lastUsedRow?.value ?? null,
            };
            } catch (err) { try { writeLog('IPC:ERROR', `channel:notes:recent error:${err instanceof Error ? err.message : String(err)}`); } catch { /* ignore */ } throw err; }
        },
    );

    // ── notes:getLastUsed ────────────────────────────────────────────────────
    ipcMain.handle(
        NOTES_CHANNELS.GET_LAST_USED,
        async (_event, vaultPath: string) => {
            try { writeLog('IPC:received', 'notes:getLastUsed'); } catch { /* ignore */ }
            try {
            const db = getDb(vaultPath);
            const row = db.prepare(
                "SELECT value FROM settings WHERE key = 'lastUsedNoteId'",
            ).get() as { value: string } | undefined;
            return row?.value ?? null;
            } catch (err) { try { writeLog('IPC:ERROR', `channel:notes:getLastUsed error:${err instanceof Error ? err.message : String(err)}`); } catch { /* ignore */ } throw err; }
        },
    );

    // ── notes:setLastUsed ────────────────────────────────────────────────────
    ipcMain.handle(
        NOTES_CHANNELS.SET_LAST_USED,
        async (_event, vaultPath: string, noteId: string) => {
            try { writeLog('IPC:received', 'notes:setLastUsed'); } catch { /* ignore */ }
            try {
            const db = getDb(vaultPath);
            db.prepare(
                `INSERT INTO settings (key, value) VALUES ('lastUsedNoteId', ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            ).run(noteId);
            } catch (err) { try { writeLog('IPC:ERROR', `channel:notes:setLastUsed error:${err instanceof Error ? err.message : String(err)}`); } catch { /* ignore */ } throw err; }
        },
    );

    // ── notes:appendChunk ────────────────────────────────────────────────────
    // New handler: checks existence, detects duplicates, handles live-vs-disk
    // append, and broadcasts to other windows.
    ipcMain.handle(
        NOTES_CHANNELS.APPEND_CHUNK,
        async (
            _event,
            vaultPath: string,
            noteId: string,
            text: string,
            sourceFile: string,
            sourcePage: number,
        ): Promise<{ ok: boolean; noteTitle?: string; duplicate?: boolean; reason?: string }> => {
            try { writeLog('IPC:received', 'notes:appendChunk'); } catch { /* ignore */ }
            try {
            const db = getDb(vaultPath);
            let row = db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId) as NoteRow | undefined;

            // noteId might be a files.id — resolve via file_path
            if (!row) {
                const fileRow = db.prepare('SELECT id, path, name FROM files WHERE id = ?').get(noteId) as { id: string; path: string; name: string } | undefined;
                if (fileRow && fileRow.path.endsWith('.md')) {
                    const content = fs.existsSync(fileRow.path) ? fs.readFileSync(fileRow.path, 'utf-8') : '';
                    const title = path.basename(fileRow.path, '.md');
                    const subject = path.relative(vaultPath, path.dirname(fileRow.path)).split(path.sep)[0] || null;
                    const now = Math.floor(Date.now() / 1000);
                    db.prepare(`
                        INSERT OR IGNORE INTO notes (id, title, content, file_path, subject, source_file_id, source_page, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)
                    `).run(noteId, title, content, fileRow.path, subject, now, now);
                    row = db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId) as NoteRow | undefined;
                }
            }

            // Note doesn't exist at all
            if (!row || !row.file_path) {
                return { ok: false, reason: 'not_found' };
            }

            // Note's file was deleted from disk
            if (!fs.existsSync(row.file_path)) {
                // Clean up the DB row so it doesn't linger
                db.prepare('DELETE FROM notes WHERE id = ?').run(noteId);
                return { ok: false, reason: 'deleted' };
            }

            assertInsideVault(vaultPath, row.file_path);

            // Clean the selected text
            const cleaned = text
                .replace(/(\w)-\n(\w)/g, '$1$2')
                .replace(/\n+/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();

            // Duplicate check: see if the cleaned text already exists in the note
            const existing = fs.readFileSync(row.file_path, 'utf-8');
            const isDuplicate = existing.includes(cleaned);

            // Format the block
            const block = `> ${cleaned}\n\n*From: ${sourceFile}, p.${sourcePage}*\n\n---\n`;

            // Append with proper spacing
            const separator = existing.length === 0 ? '' : existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
            const newContent = existing + separator + block;

            try {
                fs.writeFileSync(row.file_path, newContent, 'utf-8');
            } catch {
                return { ok: false, reason: 'write_failed', noteTitle: row.title };
            }

            // Update DB
            const now = Math.floor(Date.now() / 1000);
            db.prepare('UPDATE notes SET content = ?, updated_at = ? WHERE id = ?')
                .run(newContent, now, noteId);

            // Update lastUsedNoteId
            db.prepare(
                `INSERT INTO settings (key, value) VALUES ('lastUsedNoteId', ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            ).run(noteId);

            // Broadcast live append event to ALL windows so open editors refresh
            for (const win of BrowserWindow.getAllWindows()) {
                win.webContents.send('notes:liveAppend', {
                    noteId,
                    filePath: row.file_path,
                    chunk: block,
                });
            }

            return { ok: true, noteTitle: row.title, duplicate: isDuplicate };
            } catch (err) { try { writeLog('IPC:ERROR', `channel:notes:appendChunk error:${err instanceof Error ? err.message : String(err)}`); } catch { /* ignore */ } throw err; }
        },
    );
}
