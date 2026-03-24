// ── File System ─────────────────────────────────────────────────────────────

export type FileNodeType = 'file' | 'folder';

export type FileNode = {
  name: string;
  path: string;
  type: FileNodeType;
  children?: FileNode[];
  /** lower-case extension without dot: 'pdf' | 'md' | 'txt' | 'pptx' */
  fileType?: string;
};

// ── Indexing ─────────────────────────────────────────────────────────────────

export type IndexStatus = {
  total: number;
  indexed: number;
  failed: number;
  inProgress: boolean;
};

export type AppUpdateState = {
  checked: boolean;
  available: boolean;
  currentVersion: string;
  latestVersion: string | null;
  downloadUrl: string | null;
  releaseUrl: string | null;
  error: string | null;
};

export type IndexedFile = {
  id: string;
  path: string;
  name: string;
  type: 'pdf' | 'pptx' | 'md' | 'txt';
  subject: string | null;
  size: number | null;
  mtime_ms: number | null;
  content_hash: string | null;
  indexed_at: number | null;
  created_at: number;
};

export type Chunk = {
  id: string;
  file_id: string;
  page_or_slide: number | null;
  text: string;
  chunk_index: number;
  is_annotation: number; // 0 | 1
};

export type ChunkWithVector = Chunk & {
  vector: number[];
};

// ── Search ───────────────────────────────────────────────────────────────────

export type SearchResultCategory = 'page' | 'file' | 'note' | 'annotation';

export type SearchResult = {
  id: string;
  file_id: string;
  file_name: string;
  file_path: string;
  file_type: string;
  subject: string | null;
  page_or_slide: number | null;
  text: string;
  score: number;
  is_annotation: number;
  category: SearchResultCategory;
  source: 'fts' | 'semantic' | 'note';
};

// ── Notes ────────────────────────────────────────────────────────────────────

export type NoteSummary = {
  id: string;
  title: string;
  file_path: string;
  subject: string | null;
  source_file_id: string | null;
  source_page: number | null;
  created_at: number;
  updated_at: number;
};

export type NoteDetail = NoteSummary & {
  content: string;
};

// ── Annotations ──────────────────────────────────────────────────────────────

export type AnnotationType = 'highlight' | 'sticky' | 'textbox' | 'draw' | 'image';

export type AnnotationBase = {
  id: string;
  file_id: string;
  page: number;
  type: AnnotationType;
};

export type HighlightAnnotation = AnnotationBase & {
  type: 'highlight';
  rects: Array<{ x: number; y: number; w: number; h: number }>;
  color: string;
  text: string;
};

export type StickyAnnotation = AnnotationBase & {
  type: 'sticky';
  x: number;
  y: number;
  content: string;
};

export type DrawAnnotation = AnnotationBase & {
  type: 'draw';
  /** Normalized 0-1 points relative to page dimensions */
  points: Array<{ x: number; y: number }>;
  color: string;
  strokeWidth: number;
};

export type TextboxAnnotation = AnnotationBase & {
  type: 'textbox';
  x: number;       // normalized 0-1
  y: number;       // normalized 0-1
  content: string;
  color: string;
  fontSize: number; // in px at 100% zoom
};

export type Annotation = HighlightAnnotation | StickyAnnotation | DrawAnnotation | TextboxAnnotation;
