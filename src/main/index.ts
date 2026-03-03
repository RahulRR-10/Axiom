import { app, BrowserWindow, ipcMain, session } from 'electron';

import { registerVaultHandlers } from './ipc/vaultHandlers';
import { registerSearchHandlers } from './ipc/searchHandlers';
import { registerAnnotationHandlers } from './ipc/annotationHandlers';
import { registerNotesHandlers } from './ipc/notesHandlers';

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

app.whenReady().then(() => {
  registerWindowIpcHandlers();
  registerVaultHandlers();
  registerSearchHandlers();
  registerAnnotationHandlers();
  registerNotesHandlers();
  setupWebviewSessions();
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

// ── Webview session CSP tweaks (Phase 6) ─────────────────────────────────────
function setupWebviewSessions(): void {
  const partitions = ['persist:chatgpt', 'persist:claude', 'persist:gemini'];
  for (const partition of partitions) {
    session.fromPartition(partition).webRequest.onHeadersReceived((details, callback) => {
      const headers = { ...details.responseHeaders };
      // Remove X-Frame-Options so the page can be embedded in a webview
      delete headers['x-frame-options'];
      delete headers['X-Frame-Options'];
      callback({ responseHeaders: headers });
    });
  }
}
