import { autoUpdater } from 'electron-updater';
import { dialog, ipcMain, app } from 'electron';
import type { BrowserWindow } from 'electron';

export function initAutoUpdater(getWindow: () => BrowserWindow | null): void {
  // Auto-update only makes sense in a packaged build
  if (!app.isPackaged) return;

  // Download updates silently in the background without prompting
  autoUpdater.autoDownload = true;

  // If the user clicks "Later", the update will still be installed
  // automatically the next time the app quits normally
  autoUpdater.autoInstallOnAppQuit = true;

  // When the update has been downloaded, show a native OS dialog
  // asking the user to restart now or defer until next launch
  autoUpdater.on('update-downloaded', async () => {
    const win = getWindow();
    const options: Electron.MessageBoxOptions = {
      type: 'info',
      title: 'Update Ready',
      message: 'A new version of Axiom has been downloaded.',
      detail: 'Would you like to restart now to apply the update, or apply it the next time you launch?',
      buttons: ['Restart', 'Later'],
      defaultId: 0,
      cancelId: 1,
    };

    const { response } = win && !win.isDestroyed()
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options);

    // "Restart" — quit and install the update immediately
    if (response === 0) {
      autoUpdater.quitAndInstall();
    }
    // "Later" — do nothing; autoInstallOnAppQuit ensures it applies on next launch
  });

  autoUpdater.on('error', (err) => {
    console.error('[auto-updater]', err.message);
  });

  // IPC escape hatch so the renderer can also trigger a restart if needed
  ipcMain.handle('updater:install-and-restart', () => {
    autoUpdater.quitAndInstall();
  });

  // Check for updates shortly after startup so the main window finishes loading first
  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify().catch((err: Error) => {
      console.error('[auto-updater] check failed:', err.message);
    });
  }, 3000);
}
