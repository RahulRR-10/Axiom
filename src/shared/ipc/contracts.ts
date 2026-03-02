import type {
  Annotation,
  FileNode,
  IndexStatus,
  NoteSummary,
  SearchResult,
  SpotlightResult,
} from '../types';

// ── vault:select ─────────────────────────────────────────────────────────────
export type VaultSelectRequest  = void;
export type VaultSelectResponse = string | null; // selected folder path

// ── vault:open ───────────────────────────────────────────────────────────────
export type VaultOpenRequest  = { vaultPath: string };
export type VaultOpenResponse = { files: FileNode[]; status: IndexStatus };

// ── vault:readDirectory ───────────────────────────────────────────────────────
export type VaultReadDirectoryRequest  = { path: string };
export type VaultReadDirectoryResponse = FileNode[];

// ── vault:readFile ────────────────────────────────────────────────────────────
export type VaultReadFileRequest  = { path: string };
export type VaultReadFileResponse = Buffer;

// ── vault:writeFile ───────────────────────────────────────────────────────────
export type VaultWriteFileRequest  = { path: string; data: Buffer };
export type VaultWriteFileResponse = void;

// ── vault:getIndexStatus ──────────────────────────────────────────────────────
export type VaultGetIndexStatusRequest  = { vaultPath: string };
export type VaultGetIndexStatusResponse = IndexStatus;

// ── vault:indexProgress (push, main → renderer) ────────────────────────────
export type VaultIndexProgressPayload = IndexStatus & { currentFile?: string };

// ── search:spotlight ─────────────────────────────────────────────────────────
export type SearchSpotlightRequest  = { query: string; vaultPath: string };
export type SearchSpotlightResponse = SpotlightResult[];

// ── search:full ───────────────────────────────────────────────────────────────
export type SearchFullRequest = {
  query: string;
  vaultPath: string;
  subject?: string;
  fileType?: string;
};
export type SearchFullResponse = SearchResult[];

// ── notes:create ─────────────────────────────────────────────────────────────
export type NotesCreateRequest = {
  title: string;
  subject?: string;
  vaultPath: string;
  sourceFileId?: string;
  sourcePage?: number;
};
export type NotesCreateResponse = NoteSummary;

// ── notes:list ────────────────────────────────────────────────────────────────
export type NotesListRequest  = { vaultPath: string; subject?: string };
export type NotesListResponse = NoteSummary[];

// ── annotation:save ──────────────────────────────────────────────────────────
export type AnnotationSaveRequest  = { vaultPath: string; annotation: Annotation };
export type AnnotationSaveResponse = void;

// ── annotation:load ──────────────────────────────────────────────────────────
export type AnnotationLoadRequest  = { vaultPath: string; fileId: string };
export type AnnotationLoadResponse = Annotation[];
