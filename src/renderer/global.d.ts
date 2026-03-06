import type { Annotation, FileNode, IndexStatus, NoteDetail, NoteSummary, SearchResult } from '../shared/types';
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
      search: (
        query: string,
        vaultPath: string,
        subject?: string,
        fileType?: string,
      ) => Promise<SearchResult[]>;

      // ── Annotations ────────────────────────────────────────────────────
      saveAnnotation: (vaultPath: string, annotation: Annotation) => Promise<{ id: string }>;
      loadAnnotations: (vaultPath: string, fileId: string) => Promise<Annotation[]>;
      deleteAnnotation: (vaultPath: string, annotationId: string) => Promise<{ ok: boolean }>;
      reindexPdf: (vaultPath: string, filePath: string, fileId: string) => Promise<{ ok: boolean }>;

      // ── Notes ──────────────────────────────────────────────────────────
      createNote: (vaultPath: string, targetDirectory: string, title: string, sourceFileId?: string, sourcePage?: number) => Promise<NoteSummary>;
      readNote: (vaultPath: string, noteId: string) => Promise<NoteDetail>;
      updateNote: (vaultPath: string, noteId: string, content: string) => Promise<void>;
      listNotes: (vaultPath: string) => Promise<NoteSummary[]>;
      deleteNote: (vaultPath: string, noteId: string) => Promise<{ ok: boolean }>;
      moveNote: (vaultPath: string, noteId: string, newDirectory: string) => Promise<NoteSummary>;
      renameNote: (vaultPath: string, noteId: string, newTitle: string) => Promise<NoteSummary>;
      exportNotePdf: (html: string, mdFilePath: string, vaultPath: string) => Promise<string>;

      // ── Misc ───────────────────────────────────────────────────────────
      openExternal: (url: string) => void;

      // ── AI panel ─────────────────────────────────────────────────────────
      getAIPreloadPath: () => Promise<string>;
      registerWebview: (provider: string, webContentsId: number) => void;
      vaultInject: (provider: string, prompt: string) => Promise<{ success: boolean; error?: string }>;

      // ── Window controls ────────────────────────────────────────────────
      minimizeWindow: () => Promise<void>;
      toggleMaximizeWindow: () => Promise<void>;
      closeWindow: () => Promise<void>;
      isWindowMaximized: () => Promise<boolean>;
      onWindowMaximizedChange: (callback: (isMaximized: boolean) => void) => () => void;
    };
  }
}

export { };