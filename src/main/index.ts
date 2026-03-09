import { app, BrowserWindow, dialog, ipcMain, Menu, shell, webContents } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

import { registerVaultHandlers } from './ipc/vaultHandlers';
import { registerSearchHandlers } from './ipc/searchHandlers';
import { registerAnnotationHandlers } from './ipc/annotationHandlers';
import { registerNotesHandlers } from './ipc/notesHandlers';
import { setupAISessions, writeWebviewPreload } from './ai/spoofing';
import { injectPrompt } from './ai/vaultInject';
import { initAutoUpdater } from './updater';
import { AI_CHANNELS } from '../shared/ipc/channels';
import type { VaultInjectRequest, VaultInjectResponse } from '../shared/ipc/contracts';

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

/* ── Crash logging ─────────────────────────────────────────────────────────── */
const logFile = path.join(app.getPath('userData'), 'crash.log');

function writeLog(label: string, err: unknown): void {
  const msg = err instanceof Error
    ? `${err.message}\n${err.stack ?? ''}`
    : String(err);
  const line = `[${new Date().toISOString()}] ${label}: ${msg}\n`;
  try { fs.appendFileSync(logFile, line); } catch { /* ignore */ }
  console.error(line);
}

function logStep(step: string): void {
  const line = `[${new Date().toISOString()}] STEP: ${step}\n`;
  try { fs.appendFileSync(logFile, line); } catch { /* ignore */ }
  console.log(line.trim());
}

// Catch unhandled promise rejections (most common silent crash cause)
process.on('unhandledRejection', (reason) => {
  writeLog('unhandledRejection', reason);
});

// Catch synchronous exceptions that escape all other handlers
process.on('uncaughtException', (err) => {
  writeLog('uncaughtException', err);
  dialog.showErrorBox('Axiom crashed', `${err.message}\n\nSee crash.log in:\n${logFile}`);
  app.exit(1);
});

// Catch renderer / GPU / utility process crashes
app.on('render-process-gone', (_event, wc, details) => {
  writeLog('render-process-gone', `reason=${details.reason} exitCode=${details.exitCode} url=${wc.getURL()}`);
  dialog.showErrorBox('Renderer crashed', `Reason: ${details.reason}\nExit code: ${details.exitCode}\n\nSee crash.log in:\n${logFile}`);
});

app.on('child-process-gone', (_event, details) => {
  if (details.type === 'GPU' || details.reason !== 'clean-exit') {
    writeLog('child-process-gone', `type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`);
  }
});

const appIcon = path.join(
  app.getAppPath(),
  'assets',
  process.platform === 'win32' ? 'axiom-logo.ico' :
  process.platform === 'darwin' ? 'axiom-logo.icns' :
  'axiom-logo.png'
);

if (require('electron-squirrel-startup')) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;

const getMainWindow = (): BrowserWindow | null => {
  return mainWindow ?? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
};

const emitMaximizedChanged = (): void => {
  const windowInstance = getMainWindow();
  if (!windowInstance) {
    return;
  }

  windowInstance.webContents.send('window:maximized-changed', windowInstance.isMaximized());
};

const registerWindowIpcHandlers = (): void => {
  ipcMain.handle('window:minimize', (e) => {
    BrowserWindow.fromWebContents(e.sender)?.minimize();
  });

  ipcMain.handle('window:toggle-maximize', (e) => {
    const windowInstance = BrowserWindow.fromWebContents(e.sender);
    if (!windowInstance) {
      return;
    }

    if (windowInstance.isMaximized()) {
      windowInstance.unmaximize();
      return;
    }

    windowInstance.maximize();
  });

  ipcMain.handle('window:close', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;
    // If this is the main window, close it normally (triggers 'closed' → app.quit)
    if (win === mainWindow) {
      win.close();
    } else {
      // Child windows: destroy directly so they don't interfere with the main window
      win.destroy();
    }
  });

  ipcMain.handle('window:is-maximized', (e) => {
    return BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false;
  });

  // ── Shell / file operations ──────────────────────────────────────────────
  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    return shell.openPath(url);
  });

  ipcMain.handle('shell:showItemInFolder', (_e, filePath: string) => {
    shell.showItemInFolder(filePath);
  });

  ipcMain.handle('file:makeCopy', (_e, filePath: string) => {
    const dir = path.dirname(filePath);
    const ext = path.extname(filePath);
    const base = path.basename(filePath, ext);
    let n = 1;
    let dest: string;
    do {
      dest = path.join(dir, `${base} (${n})${ext}`);
      n++;
    } while (fs.existsSync(dest));
    fs.copyFileSync(filePath, dest);
    return dest;
  });

  ipcMain.handle('file:move', (_e, src: string, destDir: string) => {
    const name = path.basename(src);
    const dest = path.join(destDir, name);
    if (fs.existsSync(dest)) throw new Error(`File already exists: ${dest}`);
    fs.renameSync(src, dest);
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('file:pathChanged', { oldPath: src, newPath: dest });
    }
    return dest;
  });

  ipcMain.handle('file:rename', (_e, filePath: string, newName: string) => {
    const dir = path.dirname(filePath);
    const dest = path.join(dir, newName);
    if (fs.existsSync(dest)) throw new Error(`File already exists: ${dest}`);
    fs.renameSync(filePath, dest);
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('file:pathChanged', { oldPath: filePath, newPath: dest });
    }
    return dest;
  });

  ipcMain.handle('file:delete', (_e, filePath: string) => {
    shell.trashItem(filePath);
  });

  ipcMain.handle('file:createFolder', (_e, folderPath: string) => {
    fs.mkdirSync(folderPath, { recursive: true });
  });

  ipcMain.handle('file:saveImage', (_e, dirPath: string, fileName: string, data: Buffer) => {
    fs.mkdirSync(dirPath, { recursive: true });
    const fullPath = path.join(dirPath, fileName);
    fs.writeFileSync(fullPath, data);
    return fullPath;
  });

  ipcMain.handle('file:selectFolder', async (_e, defaultPath: string) => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Select Destination Folder',
      defaultPath,
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle('window:openNew', (_e, filePath: string, fileType: string, vaultPathArg?: string) => {
    const child = new BrowserWindow({
      width: 1000,
      height: 700,
      frame: false,
      backgroundColor: '#1a1a1a',
      icon: appIcon,
      show: false,
      webPreferences: {
        preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        webviewTag: true,
      },
    });
    const emitChildMaximized = (): void => {
      child.webContents.send('window:maximized-changed', child.isMaximized());
    };
    child.on('maximize', emitChildMaximized);
    child.on('unmaximize', emitChildMaximized);
    child.once('ready-to-show', () => child.show());
    const sep = MAIN_WINDOW_WEBPACK_ENTRY.includes('?') ? '&' : '?';
    let url = `${MAIN_WINDOW_WEBPACK_ENTRY}${sep}singleFile=${encodeURIComponent(filePath)}&fileType=${encodeURIComponent(fileType)}`;
    if (vaultPathArg) {
      url += `&vaultPath=${encodeURIComponent(vaultPathArg)}`;
    }
    child.loadURL(url);
  });
};

const createWindow = (): void => {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    backgroundColor: '#1a1a1a',
    icon: appIcon,
    show: false,
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    emitMaximizedChanged();
  });

  mainWindow.on('maximize', emitMaximizedChanged);
  mainWindow.on('unmaximize', emitMaximizedChanged);
  mainWindow.on('closed', () => {
    mainWindow = null;
    // Quit the app when the main window closes (not when child windows close)
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);
};

// ── AI webview tracking ──────────────────────────────────────────────────────
const webviewMap = new Map<string, Electron.WebContents>();

app.whenReady().then(() => {
  logStep('app ready');
  // Remove default menu so Electron's built-in Ctrl+W accelerator doesn't close the window.
  // The renderer handles Ctrl+W itself to close workspace tabs.
  Menu.setApplicationMenu(null);

  logStep('registerWindowIpcHandlers');
  registerWindowIpcHandlers();
  logStep('registerVaultHandlers');
  registerVaultHandlers();
  logStep('registerSearchHandlers');
  registerSearchHandlers();
  logStep('registerAnnotationHandlers');
  registerAnnotationHandlers();
  logStep('registerNotesHandlers');
  registerNotesHandlers();

  logStep('setupAISessions');
  // AI webview spoofing — rewrite headers + write fingerprint preload to disk
  setupAISessions();
  logStep('writeWebviewPreload');
  const aiPreloadURL = writeWebviewPreload();
  ipcMain.handle('ai:getPreloadPath', () => aiPreloadURL);

  // ── AI vault-inject IPC ──────────────────────────────────────────────────
  ipcMain.on(AI_CHANNELS.REGISTER_WEBVIEW, (_, { provider, webContentsId }: { provider: string; webContentsId: number }) => {
    const wc = webContents.fromId(webContentsId);
    if (wc) webviewMap.set(provider, wc);
  });

  ipcMain.handle(AI_CHANNELS.VAULT_INJECT, async (_, req: VaultInjectRequest): Promise<VaultInjectResponse> => {
    const wc = webviewMap.get(req.provider);
    if (!wc) {
      return { success: false, error: `Webview for ${req.provider} not ready` };
    }
    return injectPrompt(wc, req.provider, req.prompt);
  });

  logStep('createWindow');
  createWindow();
  logStep('initAutoUpdater');
  initAutoUpdater(() => mainWindow);
  logStep('startup complete');
}).catch((err) => {
  writeLog('app.whenReady error', err);
});

app.on('window-all-closed', () => {
  // No-op: app lifecycle is tied to the main window's 'closed' event above.
  // This prevents child windows from inadvertently quitting the app.
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});


