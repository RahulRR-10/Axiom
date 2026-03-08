import { autoUpdater } from 'electron-updater';
import { ipcMain, app } from 'electron';
import type { BrowserWindow } from 'electron';

export function initAutoUpdater(getWindow: () => BrowserWindow | null): void {
  // Auto-update only makes sense in a packaged build
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  const send = (channel: string, payload?: unknown): void => {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  };

  autoUpdater.on('update-downloaded', () => {
    send('updater:update-downloaded');
  });

  autoUpdater.on('error', (err) => {
    console.error('[auto-updater]', err.message);
  });

  ipcMain.handle('updater:install-and-restart', () => {
    autoUpdater.quitAndInstall();
  });

  // Delay so the main window finishes loading before we poll
  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify().catch((err: Error) => {
      console.error('[auto-updater] check failed:', err.message);
    });
  }, 3000);
}
