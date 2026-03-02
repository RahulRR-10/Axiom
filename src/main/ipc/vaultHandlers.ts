import * as fs from 'fs';
import * as path from 'path';

import { BrowserWindow, dialog, ipcMain } from 'electron';

import { VAULT_CHANNELS } from '../../shared/ipc/channels';
import type {
  VaultGetIndexStatusResponse,
  VaultIndexProgressPayload,
  VaultOpenResponse,
  VaultReadDirectoryResponse,
} from '../../shared/ipc/contracts';
import type { FileNode, IndexStatus } from '../../shared/types';
import { getDb } from '../database/schema';
import { indexFile } from '../indexing/indexer';
import { startWatching } from '../vault/vaultWatcher';

// ── Registry ─────────────────────────────────────────────────────────────────

export function registerVaultHandlers(): void {
  ipcMain.handle(VAULT_CHANNELS.SELECT, handleSelect);
  ipcMain.handle(VAULT_CHANNELS.OPEN,           (_e, vaultPath: string) => handleOpen(vaultPath));
  ipcMain.handle(VAULT_CHANNELS.READ_DIRECTORY, (_e, dirPath: string) => handleReadDirectory(dirPath));
  ipcMain.handle(VAULT_CHANNELS.READ_FILE,      (_e, filePath: string) => handleReadFile(filePath));
  ipcMain.handle(VAULT_CHANNELS.WRITE_FILE,     (_e, filePath: string, data: Buffer) => handleWriteFile(filePath, data));
  ipcMain.handle(VAULT_CHANNELS.GET_INDEX_STATUS, (_e, vaultPath: string) => handleGetIndexStatus(vaultPath));
  ipcMain.handle(VAULT_CHANNELS.GET_FILE_ID,    (_e, vaultPath: string, filePath: string) => {
    const db  = getDb(vaultPath);
    const row = db.prepare('SELECT id FROM files WHERE path = ?').get(filePath) as { id: string } | undefined;
    return row?.id ?? null;
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
  // 1. Init DB (runs migrations)
  const db = getDb(vaultPath);

  // 2. Start file watcher
  startWatching(vaultPath);

  // 3. Build file list and kick off indexing for new/changed files
  const allFiles = walkVault(vaultPath);
  const total = allFiles.length;
  let indexed = 0;
  let failed = 0;

  void (async () => {
    for (const filePath of allFiles) {
      try {
        await indexFile(filePath, vaultPath);
      } catch (err) {
        console.error('[vault:open] Failed to index:', filePath, err);
        // Mark file as failed in DB
        db.prepare("UPDATE files SET indexed_at = -1 WHERE path = ?").run(filePath);
        failed++;
      }
      indexed++;
      broadcastProgress({ total, indexed, failed, inProgress: indexed < total }, vaultPath);
    }
    broadcastProgress({ total, indexed, failed, inProgress: false }, vaultPath);
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

function handleWriteFile(filePath: string, data: Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, data);
}

function handleGetIndexStatus(vaultPath: string): VaultGetIndexStatusResponse {
  const db = getDb(vaultPath);
  const total   = (db.prepare('SELECT COUNT(*) as n FROM files').get() as { n: number }).n;
  const indexed = (db.prepare("SELECT COUNT(*) as n FROM files WHERE indexed_at IS NOT NULL AND indexed_at != -1").get() as { n: number }).n;
  const failed  = (db.prepare("SELECT COUNT(*) as n FROM files WHERE indexed_at = -1").get() as { n: number }).n;
  return { total, indexed, failed, inProgress: false };
}

// ── Directory utilities ───────────────────────────────────────────────────────

const INDEXABLE_EXTENSIONS = new Set(['.pdf', '.pptx', '.md', '.txt']);

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
        name:     entry.name,
        path:     fullPath,
        type:     'folder',
        children: buildFileTree(fullPath),
      });
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!INDEXABLE_EXTENSIONS.has(ext)) continue;
      nodes.push({
        name:     entry.name,
        path:     fullPath,
        type:     'file',
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
