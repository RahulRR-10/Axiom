import { contextBridge, ipcRenderer } from 'electron';

import type { FileNode } from '../shared/types';

const electronAPI = {
  selectVaultFolder: async (): Promise<string | null> => null,
  readDirectory: async (_path: string): Promise<FileNode[]> => [],
  readFile: async (_path: string): Promise<Buffer> => Buffer.from([]),
  writeFile: async (_path: string, _data: Buffer): Promise<void> => undefined,
  watchVault: (_path: string, _callback: (event: string, filePath: string) => void): void => undefined,
  openExternal: (_url: string): void => undefined,
  minimizeWindow: async (): Promise<void> => {
    await ipcRenderer.invoke('window:minimize');
  },
  toggleMaximizeWindow: async (): Promise<void> => {
    await ipcRenderer.invoke('window:toggle-maximize');
  },
  closeWindow: async (): Promise<void> => {
    await ipcRenderer.invoke('window:close');
  },
  isWindowMaximized: async (): Promise<boolean> => {
    return ipcRenderer.invoke('window:is-maximized');
  },
  onWindowMaximizedChange: (callback: (isMaximized: boolean) => void): (() => void) => {
    const listener = (_event: unknown, isMaximized: boolean): void => {
      callback(isMaximized);
    };

    ipcRenderer.on('window:maximized-changed', listener);

    return () => {
      ipcRenderer.removeListener('window:maximized-changed', listener);
    };
  },
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);