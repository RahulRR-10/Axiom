import * as fs from 'fs';
import * as path from 'path';

import { app, BrowserWindow, dialog, ipcMain } from 'electron';

import { VAULT_CHANNELS } from '../../shared/ipc/channels';
import type {
  VaultGetIndexStatusResponse,
  VaultIndexProgressPayload,
  VaultOpenResponse,
  VaultReadDirectoryResponse,
} from '../../shared/ipc/contracts';
import type { FileNode, IndexStatus } from '../../shared/types';
import { getDb } from '../database/schema';
import { checkModelCompatibility } from '../database/migrations';
import { indexFile } from '../indexing/indexer';
import { warmEmbedCache } from '../indexing/embedCache';
import { startWatching } from '../vault/vaultWatcher';
import { writeLog } from '../logger';

// Simple JSON file for persisting app settings (vault path, etc.)
// Stored in the app's userData directory so it survives updates.
const SETTINGS_PATH = path.join(app.getPath('userData'), 'axiom-settings.json');

function readSettings(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeSetting(key: string, value: unknown): void {
  const settings = readSettings();
  settings[key] = value;
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings), 'utf8');
}

// ── Active indexing abort ─────────────────────────────────────────────────────
// Replaced each time handleOpen is called so the previous vault's loop stops.
let activeIndexingAbort: { aborted: boolean } | null = null;

// ── Registry ─────────────────────────────────────────────────────────────────

export function registerVaultHandlers(): void {
  ipcMain.handle(VAULT_CHANNELS.SELECT, async () => {
    try { writeLog('IPC:received', 'vault:select'); } catch { /* ignore */ }
    try { return await handleSelect(); } catch (err) { try { writeLog('IPC:ERROR', `channel:vault:select error:${err instanceof Error ? err.message : String(err)}`); } catch { /* ignore */ } throw err; }
  });
  ipcMain.handle(VAULT_CHANNELS.OPEN, async (_e, vaultPath: string) => {
    try { writeLog('IPC:received', 'vault:open'); } catch { /* ignore */ }
    try { return await handleOpen(vaultPath); } catch (err) { try { writeLog('IPC:ERROR', `channel:vault:open error:${err instanceof Error ? err.message : String(err)}`); } catch { /* ignore */ } throw err; }
  });
  ipcMain.handle(VAULT_CHANNELS.READ_DIRECTORY, (_e, dirPath: string) => {
    try { writeLog('IPC:received', 'vault:readDirectory'); } catch { /* ignore */ }
    try { return handleReadDirectory(dirPath); } catch (err) { try { writeLog('IPC:ERROR', `channel:vault:readDirectory error:${err instanceof Error ? err.message : String(err)}`); } catch { /* ignore */ } throw err; }
  });
  ipcMain.handle(VAULT_CHANNELS.READ_FILE, (_e, filePath: string) => {
    try { writeLog('IPC:received', 'vault:readFile'); } catch { /* ignore */ }
    try { return handleReadFile(filePath); } catch (err) { try { writeLog('IPC:ERROR', `channel:vault:readFile error:${err instanceof Error ? err.message : String(err)}`); } catch { /* ignore */ } throw err; }
  });
  ipcMain.handle(VAULT_CHANNELS.WRITE_FILE, (e, filePath: string, data: Buffer) => {
    try { writeLog('IPC:received', 'vault:writeFile'); } catch { /* ignore */ }
    try { return handleWriteFile(filePath, data, e.sender.id); } catch (err) { try { writeLog('IPC:ERROR', `channel:vault:writeFile error:${err instanceof Error ? err.message : String(err)}`); } catch { /* ignore */ } throw err; }
  });
  ipcMain.handle(VAULT_CHANNELS.GET_INDEX_STATUS, (_e, vaultPath: string) => {
    try { writeLog('IPC:received', 'vault:getIndexStatus'); } catch { /* ignore */ }
    try { return handleGetIndexStatus(vaultPath); } catch (err) { try { writeLog('IPC:ERROR', `channel:vault:getIndexStatus error:${err instanceof Error ? err.message : String(err)}`); } catch { /* ignore */ } throw err; }
  });
  ipcMain.handle(VAULT_CHANNELS.GET_FILE_ID, (_e, vaultPath: string, filePath: string) => {
    try { writeLog('IPC:received', 'vault:getFileId'); } catch { /* ignore */ }
    try {
      const db = getDb(vaultPath);
      const row = db.prepare('SELECT id FROM files WHERE path = ?').get(filePath) as { id: string } | undefined;
      if (row) return row.id;
      // Also check notes table — newly created notes may not be in files yet
      const noteRow = db.prepare('SELECT id FROM notes WHERE file_path = ?').get(filePath) as { id: string } | undefined;
      return noteRow?.id ?? null;
    } catch (err) { try { writeLog('IPC:ERROR', `channel:vault:getFileId error:${err instanceof Error ? err.message : String(err)}`); } catch { /* ignore */ } throw err; }
  });
  ipcMain.handle(VAULT_CHANNELS.GET_LAST_VAULT, () => {
    try { writeLog('IPC:received', 'vault:getLastVault'); } catch { /* ignore */ }
    try { return (readSettings().lastVaultPath as string) || null; } catch (err) { try { writeLog('IPC:ERROR', `channel:vault:getLastVault error:${err instanceof Error ? err.message : String(err)}`); } catch { /* ignore */ } throw err; }
  });
  ipcMain.handle(VAULT_CHANNELS.SET_LAST_VAULT, (_e, vaultPath: string) => {
    try { writeLog('IPC:received', 'vault:setLastVault'); } catch { /* ignore */ }
    try { writeSetting('lastVaultPath', vaultPath); } catch (err) { try { writeLog('IPC:ERROR', `channel:vault:setLastVault error:${err instanceof Error ? err.message : String(err)}`); } catch { /* ignore */ } throw err; }
  });
}

// ── Handler implementations ───────────────────────────────────────────────────

async function handleSelect(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Select Vault Folder',
    buttonLabel: 'Open Vault',
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

async function handleOpen(vaultPath: string): Promise<VaultOpenResponse> {
  // Cancel any in-progress indexing from a previous vault
  if (activeIndexingAbort) activeIndexingAbort.aborted = true;
  const abort = { aborted: false };
  activeIndexingAbort = abort;

  // 1. Init DB (runs migrations)
  const db = getDb(vaultPath);

  // 2. Check if embedding model changed — clears stale vectors if needed
  await checkModelCompatibility(db, vaultPath);

  // 3. Pre-populate in-memory embed cache from DB
  warmEmbedCache(db);

  // 4. Start file watcher
  startWatching(vaultPath);

  // 3. Build file list and kick off indexing for new/changed files
  const allFiles = walkVault(vaultPath);
  const total = allFiles.length;
  let indexed = 0;
  let failed = 0;

  void (async () => {
    try {
      for (const filePath of allFiles) {
        if (abort.aborted) break;
        try {
          await indexFile(filePath, vaultPath);
        } catch (err) {
          console.error('[vault:open] Failed to index:', filePath, err);
          // Mark file as failed in DB so the UI shows it as failed, not stuck
          try {
            db.prepare("UPDATE files SET indexed_at = -1 WHERE path = ?").run(filePath);
          } catch { /* db write may also fail — don't let it crash the loop */ }
          failed++;
        }
        indexed++;
        if (!abort.aborted) {
          broadcastProgress({ total, indexed, failed, inProgress: indexed < total }, vaultPath);
        }
        // Yield to event loop between files so the renderer stays responsive
        await new Promise((r) => setTimeout(r, 0));
      }
    } catch (fatal) {
      console.error('[vault:open] Fatal indexing error — aborting loop:', fatal);
    } finally {
      if (!abort.aborted) {
        broadcastProgress({ total, indexed, failed, inProgress: false }, vaultPath);
      }
    }
  })();

  // 4. Return directory tree immediately (indexing runs in background)
  const files = buildFileTree(vaultPath);
  const status: IndexStatus = { total, indexed: 0, failed: 0, inProgress: total > 0 };

  return { files, status };
}

function handleReadDirectory(dirPath: string): VaultReadDirectoryResponse {
  return buildFileTree(dirPath);
}

function handleReadFile(filePath: string): Buffer {
  return fs.readFileSync(filePath);
}

function handleWriteFile(filePath: string, data: Buffer, senderId?: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, data);
  // Broadcast so other windows showing this file can refresh
  for (const win of BrowserWindow.getAllWindows()) {
    if (senderId != null && win.webContents.id === senderId) continue;
    if (filePath.endsWith('.md')) {
      win.webContents.send('notes:saved', path.normalize(filePath).toLowerCase());
    }
    if (filePath.endsWith('.pdf')) {
      win.webContents.send('pdf:fileChanged', path.normalize(filePath).toLowerCase());
    }
  }
}

function handleGetIndexStatus(vaultPath: string): VaultGetIndexStatusResponse {
  const db = getDb(vaultPath);
  const total = (db.prepare('SELECT COUNT(*) as n FROM files').get() as { n: number }).n;
  const indexed = (db.prepare("SELECT COUNT(*) as n FROM files WHERE indexed_at IS NOT NULL AND indexed_at != -1").get() as { n: number }).n;
  const failed = (db.prepare("SELECT COUNT(*) as n FROM files WHERE indexed_at = -1").get() as { n: number }).n;
  return { total, indexed, failed, inProgress: false };
}

// ── Directory utilities ───────────────────────────────────────────────────────

const INDEXABLE_EXTENSIONS = new Set(['.pdf', '.pptx', '.md', '.txt', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp']);

function buildFileTree(rootPath: string): FileNode[] {
  const nodes: FileNode[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootPath, { withFileTypes: true });
  } catch {
    return nodes;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue; // skip .axiom etc.

    const fullPath = path.join(rootPath, entry.name);

    if (entry.isDirectory()) {
      nodes.push({
        name: entry.name,
        path: fullPath,
        type: 'folder',
        children: buildFileTree(fullPath),
      });
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!INDEXABLE_EXTENSIONS.has(ext)) continue;
      nodes.push({
        name: entry.name,
        path: fullPath,
        type: 'file',
        fileType: ext.slice(1),
      });
    }
  }

  // Folders first, then files, both alphabetically
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return nodes;
}

/** Flat list of all indexable files under vaultPath (excluding .axiom). */
function walkVault(vaultPath: string): string[] {
  const results: string[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (INDEXABLE_EXTENSIONS.has(ext)) results.push(fullPath);
      }
    }
  }

  walk(vaultPath);
  return results;
}

function broadcastProgress(payload: VaultIndexProgressPayload, _vaultPath: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(VAULT_CHANNELS.INDEX_PROGRESS, payload);
  }
}
