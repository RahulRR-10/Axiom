import * as path from 'path';

import { BrowserWindow } from 'electron';
import chokidar, { type FSWatcher } from 'chokidar';

import { getDb } from '../database/schema';
import { indexFile, purgeFile } from '../indexing/indexer';
import { VAULT_CHANNELS } from '../../shared/ipc/channels';

const WATCHED_GLOB = '**/*.{pdf,pptx,md,txt}';
const DEBOUNCE_MS  = 500;

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
  ];

  activeWatcher = chokidar.watch(WATCHED_GLOB, {
    cwd:            vaultPath,
    ignored,
    persistent:     true,
    ignoreInitial:  true, // initial scan handled by vault:open handler
    awaitWriteFinish: { stabilityThreshold: DEBOUNCE_MS, pollInterval: 100 },
  });

  activeWatcher
    .on('add',    (rel) => void handleAdd(path.join(vaultPath, rel), vaultPath))
    .on('change', (rel) => void handleChange(path.join(vaultPath, rel), vaultPath))
    .on('unlink', (rel) => void handleUnlink(path.join(vaultPath, rel), vaultPath))
    .on('error',  (err) => console.error('[watcher] Error:', err));

  console.log('[watcher] Watching', vaultPath);
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
    broadcastFileChanged(vaultPath);
  } catch (err) {
    console.error('[watcher] Failed to index new file:', filePath, err);
  }
}

async function handleChange(filePath: string, vaultPath: string): Promise<void> {
  try {
    await indexFile(filePath, vaultPath);
    broadcastFileChanged(vaultPath);
  } catch (err) {
    console.error('[watcher] Failed to re-index changed file:', filePath, err);
  }
}

async function handleUnlink(filePath: string, vaultPath: string): Promise<void> {
  try {
    const db = getDb(vaultPath);
    const row = db
      .prepare('SELECT id FROM files WHERE path = ?')
      .get(filePath) as { id: string } | undefined;

    if (row) {
      await purgeFile(row.id, vaultPath, db);
      broadcastFileChanged(vaultPath);
    }
  } catch (err) {
    console.error('[watcher] Failed to purge deleted file:', filePath, err);
  }
}

function broadcastFileChanged(vaultPath: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(VAULT_CHANNELS.FILE_CHANGED, { vaultPath });
  }
}
