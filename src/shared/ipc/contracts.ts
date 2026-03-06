import type {
  Annotation,
  FileNode,
  IndexStatus,
  NoteDetail,
  NoteSummary,
  SearchResult,
} from '../types';

// ── vault:select ─────────────────────────────────────────────────────────────
export type VaultSelectRequest = void;
export type VaultSelectResponse = string | null; // selected folder path

// ── vault:open ───────────────────────────────────────────────────────────────
export type VaultOpenRequest = { vaultPath: string };
export type VaultOpenResponse = { files: FileNode[]; status: IndexStatus };

// ── vault:readDirectory ───────────────────────────────────────────────────────
export type VaultReadDirectoryRequest = { path: string };
export type VaultReadDirectoryResponse = FileNode[];

// ── vault:readFile ────────────────────────────────────────────────────────────
export type VaultReadFileRequest = { path: string };
export type VaultReadFileResponse = Buffer;

// ── vault:writeFile ───────────────────────────────────────────────────────────
export type VaultWriteFileRequest = { path: string; data: Buffer };
export type VaultWriteFileResponse = void;

// ── vault:getIndexStatus ──────────────────────────────────────────────────────
export type VaultGetIndexStatusRequest = { vaultPath: string };
export type VaultGetIndexStatusResponse = IndexStatus;

// ── vault:indexProgress (push, main → renderer) ────────────────────────────
export type VaultIndexProgressPayload = IndexStatus & { currentFile?: string };

// ── search:query ─────────────────────────────────────────────────────────────
export type SearchQueryRequest = {
  query: string;
  vaultPath: string;
  subject?: string;
  fileType?: string;
};
export type SearchQueryResponse = SearchResult[];

// ── notes:create ─────────────────────────────────────────────────────────────
export type NotesCreateRequest = {
  vaultPath: string;
  targetDirectory: string;
  title: string;
  sourceFileId?: string;
  sourcePage?: number;
};
export type NotesCreateResponse = NoteSummary;

// ── notes:read ───────────────────────────────────────────────────────────────
export type NotesReadRequest = { vaultPath: string; noteId: string };
export type NotesReadResponse = NoteDetail;

// ── notes:update ─────────────────────────────────────────────────────────────
export type NotesUpdateRequest = { vaultPath: string; noteId: string; content: string };
export type NotesUpdateResponse = void;

// ── notes:list ────────────────────────────────────────────────────────────────
export type NotesListRequest = { vaultPath: string };
export type NotesListResponse = NoteSummary[];

// ── notes:delete ─────────────────────────────────────────────────────────────
export type NotesDeleteRequest = { vaultPath: string; noteId: string };
export type NotesDeleteResponse = { ok: boolean };

// ── notes:move ───────────────────────────────────────────────────────────────
export type NotesMoveRequest = { vaultPath: string; noteId: string; newDirectory: string };
export type NotesMoveResponse = NoteSummary;

// ── notes:rename ─────────────────────────────────────────────────────────────
export type NotesRenameRequest = { vaultPath: string; noteId: string; newTitle: string };
export type NotesRenameResponse = NoteSummary;

// ── notes:exportPdf ──────────────────────────────────────────────────────────
export type NotesExportPdfRequest = { html: string; mdFilePath: string };
export type NotesExportPdfResponse = string; // absolute path of the written PDF

// ── ai:vault-inject ─────────────────────────────────────────────────────────
export type VaultInjectRequest = { provider: string; prompt: string };
export type VaultInjectResponse = { success: boolean; error?: string };

// ── annotation:save ──────────────────────────────────────────────────────────
export type AnnotationSaveRequest = { vaultPath: string; annotation: Annotation };
export type AnnotationSaveResponse = void;

// ── annotation:load ──────────────────────────────────────────────────────────
export type AnnotationLoadRequest = { vaultPath: string; fileId: string };
export type AnnotationLoadResponse = Annotation[];
