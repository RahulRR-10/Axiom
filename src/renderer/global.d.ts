import type { Annotation, FileNode, IndexStatus, SearchResult, SpotlightResult } from '../shared/types';
import type { VaultIndexProgressPayload } from '../shared/ipc/contracts';

declare global {
  interface Window {
    electronAPI: {
      // ── Vault ──────────────────────────────────────────────────────────
      selectVaultFolder: () => Promise<string | null>;
      openVault: (vaultPath: string) => Promise<{ files: FileNode[]; status: IndexStatus }>;
      readDirectory: (dirPath: string) => Promise<FileNode[]>;
      readFile: (filePath: string) => Promise<Uint8Array>;
      writeFile: (filePath: string, data: Uint8Array) => Promise<void>;
      getIndexStatus: (vaultPath: string) => Promise<IndexStatus>;
      getFileId: (vaultPath: string, filePath: string) => Promise<string | null>;
      onIndexProgress: (callback: (payload: VaultIndexProgressPayload) => void) => () => void;
      onFileChanged: (callback: (payload: { vaultPath: string }) => void) => () => void;

      // ── Search ─────────────────────────────────────────────────────────
      spotlightSearch: (query: string, vaultPath: string) => Promise<SpotlightResult[]>;
      fullSearch: (
        query: string,
        vaultPath: string,
        subject?: string,
        fileType?: string,
      ) => Promise<SearchResult[]>;

      // ── Annotations ────────────────────────────────────────────────────
      saveAnnotation: (vaultPath: string, annotation: Annotation) => Promise<{ id: string }>;
      loadAnnotations: (vaultPath: string, fileId: string) => Promise<Annotation[]>;
      deleteAnnotation: (vaultPath: string, annotationId: string) => Promise<{ ok: boolean }>;

      // ── Misc ───────────────────────────────────────────────────────────
      openExternal: (url: string) => void;

      // ── Window controls ────────────────────────────────────────────────
      minimizeWindow: () => Promise<void>;
      toggleMaximizeWindow: () => Promise<void>;
      closeWindow: () => Promise<void>;
      isWindowMaximized: () => Promise<boolean>;
      onWindowMaximizedChange: (callback: (isMaximized: boolean) => void) => () => void;
    };
  }
}

export {};