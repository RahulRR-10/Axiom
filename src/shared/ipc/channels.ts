// ─────────────────────────────────────────────────────────────────────────────
// Typed IPC channel name constants — import these everywhere (main + preload +
// renderer) so a typo is a compile error, not a silent noop.
// ─────────────────────────────────────────────────────────────────────────────

export const VAULT_CHANNELS = {
  SELECT: 'vault:select',
  OPEN: 'vault:open',
  READ_DIRECTORY: 'vault:readDirectory',
  READ_FILE: 'vault:readFile',
  WRITE_FILE: 'vault:writeFile',
  GET_INDEX_STATUS: 'vault:getIndexStatus',
  GET_FILE_ID: 'vault:getFileId',
  GET_LAST_VAULT: 'vault:getLastVault',
  SET_LAST_VAULT: 'vault:setLastVault',
  INDEX_PROGRESS: 'vault:indexProgress',   // main → renderer push event
  FILE_CHANGED: 'vault:fileChanged',     // main → renderer push event
  FILE_DELETED: 'vault:fileDeleted',     // main → renderer push event (deleted file path)
} as const;

export const SEARCH_CHANNELS = {
  QUERY: 'search:query',
} as const;

export const NOTES_CHANNELS = {
  CREATE: 'notes:create',
  READ: 'notes:read',
  LIST: 'notes:list',
  UPDATE: 'notes:update',
  DELETE: 'notes:delete',
  MOVE: 'notes:move',
  RENAME: 'notes:rename',
  EXPORT_PDF: 'notes:exportPdf',
  APPEND: 'notes:append',
  APPEND_CHUNK: 'notes:appendChunk',
  RECENT: 'notes:recent',
  GET_LAST_USED: 'notes:getLastUsed',
  SET_LAST_USED: 'notes:setLastUsed',
} as const;

export const ANNOTATION_CHANNELS = {
  SAVE: 'annotation:save',
  LOAD: 'annotation:load',
  DELETE: 'annotation:delete',
  REINDEX_PDF: 'annotation:reindexPdf',
} as const;

export const WINDOW_CHANNELS = {
  MINIMIZE: 'window:minimize',
  TOGGLE_MAXIMIZE: 'window:toggle-maximize',
  CLOSE: 'window:close',
  IS_MAXIMIZED: 'window:is-maximized',
  MAXIMIZED_CHANGED: 'window:maximized-changed',
} as const;

export const AI_CHANNELS = {
  VAULT_INJECT: 'ai:vault-inject',
  REGISTER_WEBVIEW: 'ai:register-webview',
} as const;

export const SCREENSHOT_CHANNELS = {
  TRIGGER: 'screenshot:trigger',        // renderer → main: ask to capture
  CAPTURED: 'screenshot:captured',       // main → renderer: push data URL
} as const;

export const UPDATER_CHANNELS = {
  GET_STATE: 'updater:get-state',
  STATE_CHANGED: 'updater:state-changed',
  DOWNLOAD_LATEST: 'updater:download-latest',
} as const;

export const WORKSPACE_CHANNELS = {
  SAVE: 'workspace:save',
  LOAD: 'workspace:load',
} as const;
