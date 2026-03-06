import { app, BrowserWindow, ipcMain, webContents } from 'electron';

import { registerVaultHandlers } from './ipc/vaultHandlers';
import { registerSearchHandlers } from './ipc/searchHandlers';
import { registerAnnotationHandlers } from './ipc/annotationHandlers';
import { registerNotesHandlers } from './ipc/notesHandlers';
import { setupAISessions, writeWebviewPreload } from './ai/spoofing';
import { injectPrompt } from './ai/vaultInject';
import { AI_CHANNELS } from '../shared/ipc/channels';
import type { VaultInjectRequest, VaultInjectResponse } from '../shared/ipc/contracts';

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

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
  ipcMain.handle('window:minimize', () => {
    getMainWindow()?.minimize();
  });

  ipcMain.handle('window:toggle-maximize', () => {
    const windowInstance = getMainWindow();
    if (!windowInstance) {
      return;
    }

    if (windowInstance.isMaximized()) {
      windowInstance.unmaximize();
      return;
    }

    windowInstance.maximize();
  });

  ipcMain.handle('window:close', () => {
    getMainWindow()?.close();
  });

  ipcMain.handle('window:is-maximized', () => {
    return getMainWindow()?.isMaximized() ?? false;
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
  });

  mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);
};

// ── AI webview tracking ──────────────────────────────────────────────────────
const webviewMap = new Map<string, Electron.WebContents>();

app.whenReady().then(() => {
  registerWindowIpcHandlers();
  registerVaultHandlers();
  registerSearchHandlers();
  registerAnnotationHandlers();
  registerNotesHandlers();

  // AI webview spoofing — rewrite headers + write fingerprint preload to disk
  setupAISessions();
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

  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});


