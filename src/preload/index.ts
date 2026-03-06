import { contextBridge, ipcRenderer } from 'electron';

import { VAULT_CHANNELS, WINDOW_CHANNELS, SEARCH_CHANNELS, ANNOTATION_CHANNELS, NOTES_CHANNELS, AI_CHANNELS } from '../shared/ipc/channels';
import type { FileNode, IndexStatus, SearchResult, Annotation, NoteSummary, NoteDetail } from '../shared/types';
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
  search: (
    query: string,
    vaultPath: string,
    subject?: string,
    fileType?: string,
  ): Promise<SearchResult[]> =>
    ipcRenderer.invoke(SEARCH_CHANNELS.QUERY, query, vaultPath, subject, fileType),

  // ── Annotations ─────────────────────────────────────────────────────────
  saveAnnotation: (vaultPath: string, annotation: Annotation): Promise<{ id: string }> =>
    ipcRenderer.invoke(ANNOTATION_CHANNELS.SAVE, vaultPath, annotation),

  loadAnnotations: (vaultPath: string, fileId: string): Promise<Annotation[]> =>
    ipcRenderer.invoke(ANNOTATION_CHANNELS.LOAD, vaultPath, fileId),

  deleteAnnotation: (vaultPath: string, annotationId: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(ANNOTATION_CHANNELS.DELETE, vaultPath, annotationId),

  reindexPdf: (vaultPath: string, filePath: string, fileId: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(ANNOTATION_CHANNELS.REINDEX_PDF, vaultPath, filePath, fileId),

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
  exportNotePdf: (html: string, mdFilePath: string, vaultPath: string): Promise<string> =>
    ipcRenderer.invoke(NOTES_CHANNELS.EXPORT_PDF, html, mdFilePath, vaultPath),
  // ── Misc ─────────────────────────────────────────────────────────────────
  openExternal: (url: string): void => {
    void ipcRenderer.invoke('shell:openExternal', url);
  },

  showItemInFolder: (filePath: string): void => {
    void ipcRenderer.invoke('shell:showItemInFolder', filePath);
  },

  makeCopy: (filePath: string): Promise<string> =>
    ipcRenderer.invoke('file:makeCopy', filePath),

  moveFile: (src: string, destDir: string): Promise<string> =>
    ipcRenderer.invoke('file:move', src, destDir),

  renameFile: (filePath: string, newName: string): Promise<string> =>
    ipcRenderer.invoke('file:rename', filePath, newName),

  deleteFile: (filePath: string): Promise<void> =>
    ipcRenderer.invoke('file:delete', filePath),

  createFolder: (folderPath: string): Promise<void> =>
    ipcRenderer.invoke('file:createFolder', folderPath),

  saveImage: (dirPath: string, fileName: string, data: Uint8Array): Promise<string> =>
    ipcRenderer.invoke('file:saveImage', dirPath, fileName, Buffer.from(data)),

  selectFolder: (defaultPath: string): Promise<string | null> =>
    ipcRenderer.invoke('file:selectFolder', defaultPath),

  openNewWindow: (filePath: string, fileType: string, vaultPath?: string): Promise<void> =>
    ipcRenderer.invoke('window:openNew', filePath, fileType, vaultPath),

  broadcastAnnotationsSaved: (fileId: string): void =>
    ipcRenderer.send('annotations:broadcastSaved', fileId),

  onAnnotationsSaved: (callback: (fileId: string) => void): (() => void) => {
    const listener = (_: unknown, fileId: string): void => callback(fileId);
    ipcRenderer.on('annotations:saved', listener);
    return () => ipcRenderer.removeListener('annotations:saved', listener);
  },

  broadcastNoteSaved: (noteId: string, filePath: string): void =>
    ipcRenderer.send('notes:broadcastSaved', noteId, filePath),

  onNoteSaved: (callback: (noteId: string, filePath: string) => void): (() => void) => {
    const listener = (_: unknown, noteId: string, filePath: string): void => callback(noteId, filePath);
    ipcRenderer.on('notes:saved', listener);
    return () => ipcRenderer.removeListener('notes:saved', listener);
  },

  onPdfFileChanged: (callback: (filePath: string) => void): (() => void) => {
    const listener = (_: unknown, filePath: string): void => callback(filePath);
    ipcRenderer.on('pdf:fileChanged', listener);
    return () => ipcRenderer.removeListener('pdf:fileChanged', listener);
  },


  // ── AI panel ─────────────────────────────────────────────────────────────
  getAIPreloadPath: (): Promise<string> =>
    ipcRenderer.invoke('ai:getPreloadPath'),

  registerWebview: (provider: string, webContentsId: number): void =>
    ipcRenderer.send(AI_CHANNELS.REGISTER_WEBVIEW, { provider, webContentsId }),

  vaultInject: (provider: string, prompt: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(AI_CHANNELS.VAULT_INJECT, { provider, prompt }),

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