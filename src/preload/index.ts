import { contextBridge, ipcRenderer } from 'electron';

import { VAULT_CHANNELS, WINDOW_CHANNELS, SEARCH_CHANNELS, ANNOTATION_CHANNELS, NOTES_CHANNELS } from '../shared/ipc/channels';
import type { FileNode, IndexStatus, SpotlightResult, SearchResult, Annotation, NoteSummary, NoteDetail } from '../shared/types';
import type { VaultIndexProgressPayload } from '../shared/ipc/contracts';

const electronAPI = {
  // ── Vault ────────────────────────────────────────────────────────────────
  selectVaultFolder: (): Promise<string | null> =>
    ipcRenderer.invoke(VAULT_CHANNELS.SELECT),

  openVault: (vaultPath: string): Promise<{ files: FileNode[]; status: IndexStatus }> =>
    ipcRenderer.invoke(VAULT_CHANNELS.OPEN, vaultPath),

  readDirectory: (dirPath: string): Promise<FileNode[]> =>
    ipcRenderer.invoke(VAULT_CHANNELS.READ_DIRECTORY, dirPath),

  readFile: (filePath: string): Promise<Uint8Array> =>
    ipcRenderer
      .invoke(VAULT_CHANNELS.READ_FILE, filePath)
      .then((buf: Buffer) => new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)),

  writeFile: (filePath: string, data: Uint8Array): Promise<void> =>
    ipcRenderer.invoke(VAULT_CHANNELS.WRITE_FILE, filePath, Buffer.from(data)),

  getIndexStatus: (vaultPath: string): Promise<IndexStatus> =>
    ipcRenderer.invoke(VAULT_CHANNELS.GET_INDEX_STATUS, vaultPath),

  getFileId: (vaultPath: string, filePath: string): Promise<string | null> =>
    ipcRenderer.invoke(VAULT_CHANNELS.GET_FILE_ID, vaultPath, filePath),

  onIndexProgress: (
    callback: (payload: VaultIndexProgressPayload) => void,
  ): (() => void) => {
    const listener = (_: unknown, payload: VaultIndexProgressPayload): void => callback(payload);
    ipcRenderer.on(VAULT_CHANNELS.INDEX_PROGRESS, listener);
    return () => ipcRenderer.removeListener(VAULT_CHANNELS.INDEX_PROGRESS, listener);
  },

  onFileChanged: (callback: (payload: { vaultPath: string }) => void): (() => void) => {
    const listener = (_: unknown, payload: { vaultPath: string }): void => callback(payload);
    ipcRenderer.on(VAULT_CHANNELS.FILE_CHANGED, listener);
    return () => ipcRenderer.removeListener(VAULT_CHANNELS.FILE_CHANGED, listener);
  },

  // ── Search ───────────────────────────────────────────────────────────────
  spotlightSearch: (query: string, vaultPath: string): Promise<SpotlightResult[]> =>
    ipcRenderer.invoke(SEARCH_CHANNELS.SPOTLIGHT, query, vaultPath),

  fullSearch: (
    query: string,
    vaultPath: string,
    subject?: string,
    fileType?: string,
  ): Promise<SearchResult[]> =>
    ipcRenderer.invoke(SEARCH_CHANNELS.FULL, query, vaultPath, subject, fileType),

  // ── Annotations ─────────────────────────────────────────────────────────
  saveAnnotation: (vaultPath: string, annotation: Annotation): Promise<{ id: string }> =>
    ipcRenderer.invoke(ANNOTATION_CHANNELS.SAVE, vaultPath, annotation),

  loadAnnotations: (vaultPath: string, fileId: string): Promise<Annotation[]> =>
    ipcRenderer.invoke(ANNOTATION_CHANNELS.LOAD, vaultPath, fileId),

  deleteAnnotation: (vaultPath: string, annotationId: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(ANNOTATION_CHANNELS.DELETE, vaultPath, annotationId),

  // ── Notes ──────────────────────────────────────────────────────────────
  createNote: (
    vaultPath: string,
    targetDirectory: string,
    title: string,
    sourceFileId?: string,
    sourcePage?: number,
  ): Promise<NoteSummary> =>
    ipcRenderer.invoke(NOTES_CHANNELS.CREATE, vaultPath, targetDirectory, title, sourceFileId, sourcePage),

  readNote: (vaultPath: string, noteId: string): Promise<NoteDetail> =>
    ipcRenderer.invoke(NOTES_CHANNELS.READ, vaultPath, noteId),

  updateNote: (vaultPath: string, noteId: string, content: string): Promise<void> =>
    ipcRenderer.invoke(NOTES_CHANNELS.UPDATE, vaultPath, noteId, content),

  listNotes: (vaultPath: string): Promise<NoteSummary[]> =>
    ipcRenderer.invoke(NOTES_CHANNELS.LIST, vaultPath),

  deleteNote: (vaultPath: string, noteId: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(NOTES_CHANNELS.DELETE, vaultPath, noteId),

  moveNote: (vaultPath: string, noteId: string, newDirectory: string): Promise<NoteSummary> =>
    ipcRenderer.invoke(NOTES_CHANNELS.MOVE, vaultPath, noteId, newDirectory),

  renameNote: (vaultPath: string, noteId: string, newTitle: string): Promise<NoteSummary> =>
    ipcRenderer.invoke(NOTES_CHANNELS.RENAME, vaultPath, noteId, newTitle),

  // ── Misc ─────────────────────────────────────────────────────────────────
  openExternal: (url: string): void => {
    void ipcRenderer.invoke('shell:openExternal', url);
  },

  // ── Window controls ──────────────────────────────────────────────────────
  minimizeWindow: (): Promise<void> =>
    ipcRenderer.invoke(WINDOW_CHANNELS.MINIMIZE),

  toggleMaximizeWindow: (): Promise<void> =>
    ipcRenderer.invoke(WINDOW_CHANNELS.TOGGLE_MAXIMIZE),

  closeWindow: (): Promise<void> =>
    ipcRenderer.invoke(WINDOW_CHANNELS.CLOSE),

  isWindowMaximized: (): Promise<boolean> =>
    ipcRenderer.invoke(WINDOW_CHANNELS.IS_MAXIMIZED),

  onWindowMaximizedChange: (callback: (isMaximized: boolean) => void): (() => void) => {
    const listener = (_event: unknown, isMaximized: boolean): void => callback(isMaximized);
    ipcRenderer.on(WINDOW_CHANNELS.MAXIMIZED_CHANGED, listener);
    return () => ipcRenderer.removeListener(WINDOW_CHANNELS.MAXIMIZED_CHANGED, listener);
  },
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);