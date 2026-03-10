import * as fs from 'fs';
import * as path from 'path';

import { BrowserWindow } from 'electron';
import chokidar, { type FSWatcher } from 'chokidar';

import { getDb } from '../database/schema';
import { indexFile, purgeFile } from '../indexing/indexer';
import { VAULT_CHANNELS } from '../../shared/ipc/channels';
import type { VaultIndexProgressPayload } from '../../shared/ipc/contracts';

const WATCHED_EXTENSIONS = new Set(['.pdf', '.pptx', '.md', '.txt', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp']);
const DEBOUNCE_MS = 500;

let activeWatcher: FSWatcher | null = null;

/**
 * Start watching `vaultPath` for file changes.
 * Calling startWatching again stops the previous watcher first.
 */
export function startWatching(vaultPath: string): void {
  stopWatching();

  const ignored = [
    path.join(vaultPath, '.axiom', '**'),
    /(^|[/\\])\../, // dotfiles
    // Allow directories (so chokidar traverses into them), ignore non-indexable files
    (filePath: string, stats?: fs.Stats) => {
      if (!stats || stats.isDirectory()) return false;
      return !WATCHED_EXTENSIONS.has(path.extname(filePath).toLowerCase());
    },
  ];

  activeWatcher = chokidar.watch(vaultPath, {
    ignored,
    persistent: true,
    ignoreInitial: true, // initial scan handled by vault:open handler
    awaitWriteFinish: { stabilityThreshold: DEBOUNCE_MS, pollInterval: 100 },
  });

  activeWatcher
    .on('add', (abs) => void handleAdd(abs, vaultPath))
    .on('change', (abs) => void handleChange(abs, vaultPath))
    .on('unlink', (abs) => void handleUnlink(abs, vaultPath))
    .on('error', (err) => console.error('[watcher] Error:', err));
}

export function stopWatching(): void {
  if (activeWatcher) {
    void activeWatcher.close();
    activeWatcher = null;
  }
}

// ── Event handlers ────────────────────────────────────────────────────────────

async function handleAdd(filePath: string, vaultPath: string): Promise<void> {
  try {
    await indexFile(filePath, vaultPath);
  } catch (err) {
    console.error('[watcher] Failed to index new file:', filePath, err);
  }
  broadcastIndexStatus(vaultPath);
  broadcastFileChanged(vaultPath);
}

async function handleChange(filePath: string, vaultPath: string): Promise<void> {
  try {
    await indexFile(filePath, vaultPath);
  } catch (err) {
    console.error('[watcher] Failed to re-index changed file:', filePath, err);
  }
  broadcastIndexStatus(vaultPath);
  broadcastFileChanged(vaultPath);
}

async function handleUnlink(filePath: string, vaultPath: string): Promise<void> {
  try {
    const db = getDb(vaultPath);
    const row = db
      .prepare('SELECT id FROM files WHERE path = ?')
      .get(filePath) as { id: string } | undefined;

    if (row) {
      await purgeFile(row.id, vaultPath, db);
    }
  } catch (err) {
    console.error('[watcher] Failed to purge deleted file:', filePath, err);
  }
  // Always notify the renderer so the file tree refreshes, even if purge failed
  broadcastFileChanged(vaultPath);
}

function broadcastIndexStatus(vaultPath: string): void {
  try {
    const db = getDb(vaultPath);
    const total = (db.prepare('SELECT COUNT(*) as n FROM files').get() as { n: number }).n;
    const indexed = (db.prepare("SELECT COUNT(*) as n FROM files WHERE indexed_at IS NOT NULL AND indexed_at != -1").get() as { n: number }).n;
    const failed = (db.prepare("SELECT COUNT(*) as n FROM files WHERE indexed_at = -1").get() as { n: number }).n;
    const payload: VaultIndexProgressPayload = { total, indexed, failed, inProgress: false };
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(VAULT_CHANNELS.INDEX_PROGRESS, payload);
    }
  } catch (err) {
    console.error('[watcher] Failed to broadcast index status:', err);
  }
}

export function broadcastFileChanged(vaultPath: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(VAULT_CHANNELS.FILE_CHANGED, { vaultPath });
  }
}
