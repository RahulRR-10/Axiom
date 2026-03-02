import type { FileNode } from '../shared/types';

declare global {
  interface Window {
    electronAPI: {
      selectVaultFolder: () => Promise<string | null>;
      readDirectory: (path: string) => Promise<FileNode[]>;
      readFile: (path: string) => Promise<Buffer>;
      writeFile: (path: string, data: Buffer) => Promise<void>;
      watchVault: (path: string, callback: (event: string, filePath: string) => void) => void;
      openExternal: (url: string) => void;
      minimizeWindow: () => Promise<void>;
      toggleMaximizeWindow: () => Promise<void>;
      closeWindow: () => Promise<void>;
      isWindowMaximized: () => Promise<boolean>;
      onWindowMaximizedChange: (callback: (isMaximized: boolean) => void) => () => void;
    };
  }
}

export {};