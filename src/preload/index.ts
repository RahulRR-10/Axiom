import { contextBridge, ipcRenderer, webUtils } from 'electron';

import { VAULT_CHANNELS, WINDOW_CHANNELS, SEARCH_CHANNELS, ANNOTATION_CHANNELS, NOTES_CHANNELS, AI_CHANNELS, UPDATER_CHANNELS } from '../shared/ipc/channels';
import type { FileNode, IndexStatus, SearchResult, Annotation, NoteSummary, NoteDetail, AppUpdateState } from '../shared/types';
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

  getLastVault: (): Promise<string | null> =>
    ipcRenderer.invoke(VAULT_CHANNELS.GET_LAST_VAULT),

  setLastVault: (vaultPath: string): Promise<void> =>
    ipcRenderer.invoke(VAULT_CHANNELS.SET_LAST_VAULT, vaultPath),

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

  updateNote: (vaultPath: string, noteId: string, content: string, lastLoadedAt?: number): Promise<{ ok: true } | { ok: false; reason: string }> =>
    ipcRenderer.invoke(NOTES_CHANNELS.UPDATE, vaultPath, noteId, content, lastLoadedAt),

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

  appendToNote: (
    vaultPath: string,
    noteId: string,
    selectedText: string,
    sourceFile: string,
    sourcePage: number,
  ): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(NOTES_CHANNELS.APPEND, vaultPath, noteId, selectedText, sourceFile, sourcePage),

  appendChunk: (
    vaultPath: string,
    noteId: string,
    text: string,
    sourceFile: string,
    sourcePage: number,
  ): Promise<{ ok: boolean; noteTitle?: string; duplicate?: boolean; reason?: string }> =>
    ipcRenderer.invoke(NOTES_CHANNELS.APPEND_CHUNK, vaultPath, noteId, text, sourceFile, sourcePage),

  onNoteLiveAppend: (
    callback: (payload: { noteId: string; filePath: string; chunk: string }) => void,
  ): (() => void) => {
    const listener = (_: unknown, payload: { noteId: string; filePath: string; chunk: string }): void => callback(payload);
    ipcRenderer.on('notes:liveAppend', listener);
    return () => ipcRenderer.removeListener('notes:liveAppend', listener);
  },

  recentNotes: (vaultPath: string): Promise<{ notes: import('../shared/types').NoteSummary[]; lastUsedNoteId: string | null }> =>
    ipcRenderer.invoke(NOTES_CHANNELS.RECENT, vaultPath),

  getLastUsedNoteId: (vaultPath: string): Promise<string | null> =>
    ipcRenderer.invoke(NOTES_CHANNELS.GET_LAST_USED, vaultPath),

  setLastUsedNoteId: (vaultPath: string, noteId: string): Promise<void> =>
    ipcRenderer.invoke(NOTES_CHANNELS.SET_LAST_USED, vaultPath, noteId),
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

  importExternalFiles: (srcPaths: string[], destDir: string): Promise<string[]> =>
    ipcRenderer.invoke('file:importExternal', srcPaths, destDir),

  getPathForFile: (file: File): string =>
    webUtils.getPathForFile(file),

  renameFile: (filePath: string, newName: string): Promise<string> =>
    ipcRenderer.invoke('file:rename', filePath, newName),

  deleteFile: (filePath: string): Promise<void> =>
    ipcRenderer.invoke('file:delete', filePath),

  confirm: (message: string, confirmLabel: string): Promise<boolean> =>
    ipcRenderer.invoke('dialog:confirm', message, confirmLabel),

  confirmTrash: (message: string): Promise<boolean> =>
    ipcRenderer.invoke('dialog:confirmTrash', message),

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

  onAnnotationsSaved: (callback: (savedPath: string) => void): (() => void) => {
    const listener = (_: unknown, savedPath: string): void => callback(savedPath);
    ipcRenderer.on('annotations:saved', listener);
    return () => ipcRenderer.removeListener('annotations:saved', listener);
  },

  broadcastNoteSaved: (filePath: string): void =>
    ipcRenderer.send('notes:broadcastSaved', filePath),

  onNoteSaved: (callback: (savedPath: string) => void): (() => void) => {
    const listener = (_: unknown, savedPath: string): void => callback(savedPath);
    ipcRenderer.on('notes:saved', listener);
    return () => ipcRenderer.removeListener('notes:saved', listener);
  },

  onPdfFileChanged: (callback: (filePath: string) => void): (() => void) => {
    const listener = (_: unknown, filePath: string): void => callback(filePath);
    ipcRenderer.on('pdf:fileChanged', listener);
    return () => ipcRenderer.removeListener('pdf:fileChanged', listener);
  },

  onFilePathChanged: (callback: (oldPath: string, newPath: string) => void): (() => void) => {
    const listener = (_: unknown, { oldPath, newPath }: { oldPath: string; newPath: string }): void =>
      callback(oldPath, newPath);
    ipcRenderer.on('file:pathChanged', listener);
    return () => ipcRenderer.removeListener('file:pathChanged', listener);
  },

  onFileDeleted: (callback: (filePath: string) => void): (() => void) => {
    const listener = (_: unknown, filePath: string): void => callback(filePath);
    ipcRenderer.on('vault:fileDeleted', listener);
    return () => ipcRenderer.removeListener('vault:fileDeleted', listener);
  },


  // ── AI panel ─────────────────────────────────────────────────────────────
  getAIPreloadPath: (): Promise<string> =>
    ipcRenderer.invoke('ai:getPreloadPath'),

  registerWebview: (provider: string, webContentsId: number): void =>
    ipcRenderer.send(AI_CHANNELS.REGISTER_WEBVIEW, { provider, webContentsId }),

  vaultInject: (provider: string, serviceId: string, prompt: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(AI_CHANNELS.VAULT_INJECT, { provider, serviceId, prompt }),

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

  // ── Auto-updater ─────────────────────────────────────────────────────────
  getAppUpdateState: (): Promise<AppUpdateState> =>
    ipcRenderer.invoke(UPDATER_CHANNELS.GET_STATE),

  onAppUpdateStateChange: (callback: (state: AppUpdateState) => void): (() => void) => {
    const listener = (_: unknown, state: AppUpdateState): void => callback(state);
    ipcRenderer.on(UPDATER_CHANNELS.STATE_CHANGED, listener);
    return () => ipcRenderer.removeListener(UPDATER_CHANNELS.STATE_CHANGED, listener);
  },

  downloadLatestRelease: (): Promise<void> =>
    ipcRenderer.invoke(UPDATER_CHANNELS.DOWNLOAD_LATEST),
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
