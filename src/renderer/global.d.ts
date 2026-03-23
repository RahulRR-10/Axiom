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
      getLastVault: () => Promise<string | null>;
      setLastVault: (vaultPath: string) => Promise<void>;
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
      updateNote: (vaultPath: string, noteId: string, content: string, lastLoadedAt?: number) => Promise<{ ok: true } | { ok: false; reason: string }>;
      listNotes: (vaultPath: string) => Promise<NoteSummary[]>;
      deleteNote: (vaultPath: string, noteId: string) => Promise<{ ok: boolean }>;
      moveNote: (vaultPath: string, noteId: string, newDirectory: string) => Promise<NoteSummary>;
      renameNote: (vaultPath: string, noteId: string, newTitle: string) => Promise<NoteSummary>;
      exportNotePdf: (html: string, mdFilePath: string, vaultPath: string) => Promise<string>;
      appendToNote: (vaultPath: string, noteId: string, selectedText: string, sourceFile: string, sourcePage: number) => Promise<{ ok: boolean; noteTitle?: string; reason?: string }>;
      appendChunk: (vaultPath: string, noteId: string, text: string, sourceFile: string, sourcePage: number) => Promise<{ ok: boolean; noteTitle?: string; duplicate?: boolean; reason?: string }>;
      onNoteLiveAppend: (callback: (payload: { noteId: string; filePath: string; chunk: string }) => void) => () => void;
      recentNotes: (vaultPath: string) => Promise<{ notes: NoteSummary[]; lastUsedNoteId: string | null }>;
      getLastUsedNoteId: (vaultPath: string) => Promise<string | null>;
      setLastUsedNoteId: (vaultPath: string, noteId: string) => Promise<void>;

      // ── Misc ───────────────────────────────────────────────────────────
      openExternal: (url: string) => void;
      showItemInFolder: (filePath: string) => void;
      makeCopy: (filePath: string) => Promise<string>;
      moveFile: (src: string, destDir: string) => Promise<string>;
      importExternalFiles: (srcPaths: string[], destDir: string) => Promise<string[]>;
      getPathForFile: (file: File) => string;
      renameFile: (filePath: string, newName: string) => Promise<string>;
      deleteFile: (filePath: string) => Promise<void>;
      confirm: (message: string, confirmLabel: string) => Promise<boolean>;
      confirmTrash: (message: string) => Promise<boolean>;
      selectFolder: (defaultPath: string) => Promise<string | null>;
      openNewWindow: (filePath: string, fileType: string, vaultPath?: string) => Promise<void>;
      broadcastAnnotationsSaved: (fileId: string) => void;
      onAnnotationsSaved: (callback: (savedPath: string) => void) => () => void;
      broadcastNoteSaved: (filePath: string) => void;
      onNoteSaved: (callback: (savedPath: string) => void) => () => void;
      onPdfFileChanged: (callback: (filePath: string) => void) => () => void;
      onFilePathChanged: (callback: (oldPath: string, newPath: string) => void) => () => void;
      onFileDeleted: (callback: (filePath: string) => void) => () => void;
      createFolder: (folderPath: string) => Promise<void>;
      saveImage: (dirPath: string, fileName: string, data: Uint8Array) => Promise<string>;


      // ── AI panel ─────────────────────────────────────────────────────────
      getAIPreloadPath: () => Promise<string>;
      registerWebview: (provider: string, webContentsId: number) => void;
      vaultInject: (provider: string, serviceId: string, prompt: string) => Promise<{ success: boolean; error?: string }>;

      // ── Window controls ────────────────────────────────────────────────
      minimizeWindow: () => Promise<void>;
      toggleMaximizeWindow: () => Promise<void>;
      closeWindow: () => Promise<void>;
      isWindowMaximized: () => Promise<boolean>;
      onWindowMaximizedChange: (callback: (isMaximized: boolean) => void) => () => void;

      // ── Auto-updater ──────────────────────────────────────────────────
      onUpdateDownloaded: (callback: () => void) => () => void;
      installAndRestart: () => Promise<void>;
    };
  }
}

export { };