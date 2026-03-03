# Axiom — AI Study Operating System
## Complete Phase-by-Phase Implementation Plan for GitHub Copilot

> **How to use this document:** Feed each Phase section to Copilot one at a time. Complete every checkpoint before moving to the next phase. Never skip the Debug & Validation steps — they catch structural errors before they compound.

---

## Pre-Work: Project Scaffold

### Step 0.1 — Initialize the Electron + React Project

**Prompt for Copilot:**
> "Create a new Electron application with React and Tailwind CSS. Use electron-forge as the build tool with the webpack template. Configure it so that the React app runs in the renderer process and Electron handles the main process. Set up Tailwind CSS with a dark mode config defaulting to dark class. Use TypeScript throughout. Initialize the project structure with these top-level folders: `src/main`, `src/renderer`, `src/shared`, `src/preload`."

**Expected output:**
- `package.json` with electron-forge, react, tailwind, typescript dependencies
- `forge.config.ts`
- `webpack.main.config.ts` and `webpack.renderer.config.ts`
- `tailwind.config.ts` with `darkMode: 'class'` and content paths set
- `src/main/index.ts` — main process entry
- `src/renderer/index.tsx` — renderer entry
- `src/preload/index.ts` — preload script

**Debug checkpoint:**
```bash
npm install
npm start
```
- Electron window must open
- React "Hello World" must render
- No TypeScript errors in console

---

### Step 0.2 — Install All Dependencies

**Prompt for Copilot:**
> "Install the following dependencies for the Axiom project and add them to package.json:
> - `better-sqlite3` + `@types/better-sqlite3` (structured data)
> - `vectordb` (LanceDB for vector storage)
> - `pdf-parse` + `@types/pdf-parse` (PDF text extraction)
> - `pdf-lib` (PDF annotation writing)
> - `pdfjs-dist` (PDF rendering in viewer)
> - `@xenova/transformers` (local embeddings via all-MiniLM-L6-v2)
> - `pptx2txt` (PPT extraction)
> - `react-markdown` + `remark-gfm` (markdown rendering)
> - `codemirror` + `@codemirror/lang-markdown` (markdown editor)
> - `lucide-react` (icons)
> - `electron-store` (persistent app settings)
> - `chokidar` (file system watcher)
> - `uuid` (unique ID generation)
> Ensure native modules (better-sqlite3, vectordb) are configured for electron-rebuild in forge.config."

**Debug checkpoint:**
```bash
npm run package -- --dry-run
```
- No missing peer dependency warnings for native modules
- `electron-rebuild` runs without errors

---

## Phase 1 — Shell & Three-Panel Layout

### Step 1.1 — Main Window Configuration

**Prompt for Copilot:**
> "In `src/main/index.ts`, create the main BrowserWindow with these exact properties:
> - `width: 1400, height: 900, minWidth: 900, minHeight: 600`
> - Frameless window with custom title bar
> - `webSecurity: true`
> - `contextIsolation: true`
> - `nodeIntegration: false`
> - Preload script pointing to `src/preload/index.ts`
> - Dark background color `#1a1a1a`
> - Show window only after `ready-to-show` event fires (prevents white flash)"

---

### Step 1.2 — Preload IPC Bridge

**Prompt for Copilot:**
> "Create `src/preload/index.ts` using `contextBridge.exposeInMainWorld`. Expose an `electronAPI` object with these method stubs (full implementations come later):
> - `selectVaultFolder(): Promise<string | null>` — opens folder picker dialog
> - `readDirectory(path: string): Promise<FileNode[]>` — reads folder tree
> - `readFile(path: string): Promise<Buffer>` — reads raw file bytes
> - `writeFile(path: string, data: Buffer): Promise<void>`
> - `watchVault(path: string, callback: (event, filePath) => void): void`
> - `openExternal(url: string): void`
> Define a `FileNode` type in `src/shared/types.ts` with `name`, `path`, `type: 'file' | 'folder'`, `children?: FileNode[]`."

---

### Step 1.3 — Three-Panel Layout Component

**Prompt for Copilot:**
> "Create `src/renderer/components/layout/AppLayout.tsx`. This is the root layout. It renders three panels side by side using CSS flexbox (not grid):
> 1. `VaultSidebar` — left panel, default width 240px, collapsible to 0
> 2. `Workspace` — center panel, flex-grow: 1, always visible, never collapses
> 3. `AIPanel` — right panel, default width 340px, collapsible to 0
> 
> Use React useState to track `vaultCollapsed: boolean` and `aiCollapsed: boolean`.
> Panel width transitions must use `transition: width 200ms ease-in-out`.
> 
> When VaultSidebar is collapsed, show a thin 36px-wide icon rail with only a ⊞ expand button.
> When AIPanel is collapsed, show a thin 36px-wide strip with only a ◧ expand button on the right edge.
> 
> All panels must have `height: 100vh` and `overflow: hidden`.
> Background colors: sidebar `#1e1e1e`, workspace `#141414`, AI panel `#1e1e1e`.
> All borders between panels: `1px solid #2a2a2a`."

**Debug checkpoint:**
- Resize window: center panel must stretch, side panels must stay fixed width
- Click collapse buttons: width transition must animate smoothly
- Collapsed state icon rail must be visible and clickable to re-expand

---

### Step 1.4 — Top Bar with Global Search

**Prompt for Copilot:**
> "Create `src/renderer/components/layout/TopBar.tsx`. This renders at the very top of the Workspace panel only (not full-width). It contains:
> - A centered search input, placeholder 'Search your vault... (Ctrl+K)', width 400px max
> - Left side: app name 'Axiom' in small muted text
> - Right side: a settings gear icon (lucide-react `Settings` icon)
> Background: `#1a1a1a`, height 48px, border-bottom `1px solid #2a2a2a`.
> On `Ctrl+K` keydown (global listener), focus the search input and trigger Spotlight mode."

---

### Step 1.5 — Phase 1 Integration Test

**Prompt for Copilot:**
> "Wire up AppLayout, TopBar, and placeholder components for VaultSidebar, Workspace, and AIPanel in `src/renderer/App.tsx`. Render dummy text in each panel. Apply `class='dark'` to the root HTML element so Tailwind dark mode activates. Verify the three-panel layout renders correctly at 1400x900."

**Debug checkpoint — manually verify all of these:**
- [ ] Three panels visible with correct background colors
- [ ] Collapse/expand animations work for both sidebars
- [ ] Search bar is centered in the top bar
- [ ] Window resize keeps center panel flexible
- [ ] No layout overflow or scrollbars on the outer shell

---

## Phase 2 — Study Vault (File System + Database)

### Step 2.1 — Database Schema Setup

**Prompt for Copilot:**
> "Create `src/main/database/schema.ts`. Initialize a `better-sqlite3` database at `{vaultPath}/.axiom/axiom.db`.
>
> IMPORTANT: implement a real migration runner, not only `CREATE IF NOT EXISTS` calls.
> - Create `schema_migrations(version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`
> - Store SQL migrations as ordered files (`001_init.sql`, `002_file_tracking.sql`, etc.)
> - Apply unapplied migrations inside a transaction; record each version
> - Make migrations idempotent and safe to re-run
>
> In baseline migration, create these tables with exact SQL:
>
> ```sql
> CREATE TABLE IF NOT EXISTS files (
>   id TEXT PRIMARY KEY,
>   path TEXT UNIQUE NOT NULL,
>   name TEXT NOT NULL,
>   type TEXT NOT NULL, -- 'pdf' | 'pptx' | 'md' | 'txt'
>   subject TEXT,
>   size INTEGER,
>   mtime_ms INTEGER,
>   content_hash TEXT,
>   indexed_at INTEGER,
>   created_at INTEGER DEFAULT (unixepoch())
> );
>
> CREATE TABLE IF NOT EXISTS chunks (
>   id TEXT PRIMARY KEY,
>   file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
>   page_or_slide INTEGER,
>   text TEXT NOT NULL,
>   chunk_index INTEGER,
>   is_annotation INTEGER DEFAULT 0,
>   FOREIGN KEY(file_id) REFERENCES files(id)
> );
>
> CREATE TABLE IF NOT EXISTS notes (
>   id TEXT PRIMARY KEY,
>   title TEXT NOT NULL,
>   content TEXT DEFAULT '',
>   subject TEXT,
>   source_file_id TEXT,
>   source_page INTEGER,
>   created_at INTEGER DEFAULT (unixepoch()),
>   updated_at INTEGER DEFAULT (unixepoch())
> );
>
> CREATE TABLE IF NOT EXISTS tags (
>   id TEXT PRIMARY KEY,
>   name TEXT UNIQUE NOT NULL
> );
>
> CREATE TABLE IF NOT EXISTS file_tags (
>   file_id TEXT REFERENCES files(id) ON DELETE CASCADE,
>   tag_id TEXT REFERENCES tags(id) ON DELETE CASCADE,
>   PRIMARY KEY (file_id, tag_id)
> );
>
> CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, file_id, page_or_slide, content=chunks, content_rowid=rowid);
>
> CREATE INDEX IF NOT EXISTS idx_chunks_file_id ON chunks(file_id);
> CREATE INDEX IF NOT EXISTS idx_files_subject ON files(subject);
> CREATE INDEX IF NOT EXISTS idx_notes_subject ON notes(subject);
> ```
>
> Export a `getDb(vaultPath: string): Database` function. Use a module-level singleton pattern — if a DB is already open for that path, return it."

---

### Step 2.2 — LanceDB Vector Store Setup

**Prompt for Copilot:**
> "Create `src/main/database/vectorStore.ts`. It must:
> 1. Connect to LanceDB at `{vaultPath}/.axiom/vectors`
> 2. Create (or open if exists) a table called `chunk_vectors` with schema: `{ id: string, file_id: string, page_or_slide: number, text: string, vector: Float32Array[384] }`
> 3. Export `addVectors(chunks: ChunkWithVector[]): Promise<void>` — batch upserts
> 4. Export `searchVectors(queryVector: Float32Array, limit: number): Promise<SearchResult[]>` — cosine similarity search returning id, file_id, page_or_slide, text, score
> 5. Export `deleteVectorsByFileId(fileId: string): Promise<void>`
> Use the `vectordb` npm package. Handle the case where the table doesn't exist yet gracefully."

---

### Step 2.3 — Embeddings Worker

**Prompt for Copilot:**
> "Create `src/main/workers/embedder.ts`. Use `@xenova/transformers` to load the `Xenova/all-MiniLM-L6-v2` model. Export:
> - `initEmbedder(): Promise<void>` — downloads/caches model on first run
> - `embed(text: string): Promise<Float32Array>` — returns 384-dimension vector
> - `embedBatch(texts: string[]): Promise<Float32Array[]>` — processes in batches of 8 to avoid OOM
> The model should be cached in `{appDataPath}/models/`. Log progress during first-time download. This runs in the main process, not a web worker."

---

### Step 2.4 — File Indexing Pipeline

**Prompt for Copilot:**
> "Create `src/main/indexing/indexer.ts`. It must coordinate the full indexing pipeline for a single file. Export `indexFile(filePath: string, vaultPath: string): Promise<void>`:
>
> 1. Detect file type from extension (.pdf, .pptx, .md, .txt)
> 2. For PDF: use `pdf-parse` to extract text page by page. Store each page as a chunk in SQLite. Chunk into ~300 token pieces with 50-token overlap using a `chunkText(text, maxTokens, overlap)` utility.
> 3. For PPTX: use `pptx2txt` to extract text slide by slide. Same chunking.
> 4. For .md / .txt: read as plain text. Chunk into ~300 token pieces.
> 5. Insert file record into `files` table. Insert all chunks into `chunks` table.
> 6. Update FTS5 virtual table: `INSERT INTO chunks_fts(rowid, text, file_id, page_or_slide) SELECT rowid, text, file_id, page_or_slide FROM chunks WHERE file_id = ?`
> 7. Generate embeddings for each chunk via `embedBatch`
> 8. Upsert vectors into LanceDB via `addVectors`
> 9. Update `indexed_at` timestamp in files table
>
> If a file was already indexed (check by path + `mtime_ms` and optional `content_hash`), skip it. If the file changed, delete old chunks + FTS rows + vectors, then re-index."

---

### Step 2.5 — Vault Watcher

**Prompt for Copilot:**
> "Create `src/main/vault/vaultWatcher.ts` using `chokidar`. Export `startWatching(vaultPath: string): void`:
> - Watch all `.pdf`, `.pptx`, `.md`, `.txt` files recursively under vaultPath
> - Ignore `.axiom/**` directory
> - On `add` event: call `indexFile` for the new file
> - On `change` event: call `indexFile` which handles re-indexing
> - On `unlink` event: delete file record from SQLite (cascade deletes chunks), delete vectors from LanceDB
> Debounce all events by 500ms to avoid indexing partial writes. Send IPC events to renderer to update sidebar."

---

### Step 2.6 — Vault Sidebar Component

**Prompt for Copilot:**
> "Create `src/renderer/components/vault/VaultSidebar.tsx`. It must:
> 1. Show 'Open Vault' button if no vault is selected. On click, call `electronAPI.selectVaultFolder()` and store result in app state.
> 2. If a vault is loaded, read the folder tree from `electronAPI.readDirectory(vaultPath)` and render it as a tree of subject folders containing files.
> 3. Folder items show a chevron to expand/collapse. They group files by top-level subfolder name (treated as 'subject').
> 4. File items show an icon based on type (PDF = red, MD = blue, PPTX = orange), the filename truncated with ellipsis if too long, on a single line.
> 5. Clicking a file dispatches an `openFile` event to the Workspace.
> 6. At the top of the sidebar, show the vault folder name and a '+ New Note' button.
> 7. Style: dark background `#1e1e1e`, item hover `#2a2a2a`, active item `#3a3a3a`, text `#d4d4d4`."

---

### Step 2.7 — Typed IPC Contracts (Do this before handlers)

**Prompt for Copilot:**
> "Create shared IPC contracts before implementing handlers:
> - `src/shared/ipc/channels.ts` with channel name constants
> - `src/shared/ipc/contracts.ts` with typed request/response interfaces for all `vault:*`, `search:*`, `ai:*`, and annotation channels
> - `src/shared/types.ts` expanded with FileNode, SearchResult, IndexStatus, NoteSummary, Annotation payloads
> - `src/preload/index.ts` typed `electronAPI` interface using these contracts
>
> Enforce compile-time parity: renderer and main must import the same contract types to avoid drift."

---

### Step 2.8 — IPC Handlers for Vault Operations

**Prompt for Copilot:**
> "In `src/main/ipc/vaultHandlers.ts`, register these IPC handlers using `ipcMain.handle`:
> - `vault:select` — opens native folder dialog via `dialog.showOpenDialog`, returns selected path
> - `vault:open(path)` — initializes DB, starts file watcher, triggers full-directory index scan for unindexed files, returns list of FileNodes
> - `vault:readDirectory(path)` — reads folder structure, returns FileNode tree (exclude .axiom folder)
> - `vault:readFile(path)` — returns file buffer
> - `vault:writeFile(path, buffer)` — writes file to disk
> - `vault:getIndexStatus` — returns `{ total: number, indexed: number }` for progress display"

---

### Step 2.9 — Early Vertical Slice Gate (Must pass before Phase 3)

**Prompt for Copilot:**
> "Deliver and verify this minimum vertical slice before building PDF/AI complexity:
> 1. Open Vault
> 2. Index `.md`/`.txt` files only (temporarily skip PDF/PPTX extraction)
> 3. Run Spotlight keyword search (`Ctrl+K`) over indexed text
> 4. Open a note from results into Notes workspace mode
>
> Add temporary feature flags:
> - `ENABLE_PDF_INDEXING=false`
> - `ENABLE_PPTX_INDEXING=false`
>
> Keep pipeline interfaces unchanged so PDF/PPTX indexing can be enabled later without refactor."

**Debug checkpoint:**
```bash
# Create a test vault folder with a few PDFs and markdown files
# Launch app, click Open Vault, select the folder
```
- [ ] Vertical slice works end-to-end for md/txt (open vault → index → spotlight → open note)
- [ ] Sidebar renders folder tree correctly
- [ ] Files grouped by subject (subfolder)
- [ ] `.axiom` folder NOT visible in sidebar
- [ ] Check SQLite DB created at `{vault}/.axiom/axiom.db`
- [ ] Check `files` table populated after indexing
- [ ] Console: no unhandled promise rejections from indexer
- [ ] Check LanceDB folder created at `{vault}/.axiom/vectors`

---

## Phase 3 — Workspace: PDF Viewer

### Step 3.1 — Workspace Tab Bar

**Prompt for Copilot:**
> "Create `src/renderer/components/workspace/WorkspaceTabBar.tsx`. It renders a tab bar with three tabs: 'PDF Viewer', 'Notes', 'Search Results'. 
> - Active tab has a colored underline accent and slightly brighter text
> - Inactive tabs are muted gray
> - The tab bar sits at the top of the Workspace panel, below the TopBar
> - Height 40px, background `#1a1a1a`, border-bottom `1px solid #2a2a2a`
> - Export a `WorkspaceMode` type: `'pdf' | 'notes' | 'search'`
> - Accept `activeMode`, `onModeChange` as props"

---

### Step 3.2 — PDF.js Renderer Component

**Prompt for Copilot:**
> "Create `src/renderer/components/workspace/pdf/PDFViewer.tsx`. It must:
> 1. Accept `filePath: string` as prop
> 2. Read the PDF file as ArrayBuffer via `electronAPI.readFile(filePath)` then convert to Uint8Array
> 3. Load PDF using `pdfjsLib.getDocument({ data: uint8array })`
> 4. Set `pdfjsLib.GlobalWorkerOptions.workerSrc` to the pdfjs worker file (bundled via webpack copy plugin)
> 5. Implement virtualization immediately: only render pages within ~1 viewport above and below the current scroll window; render offscreen pages as fixed-height placeholders.
> 6. Render visible pages in a vertically scrollable container. Each visible page renders to a `<canvas>` element at the PDF's native size × devicePixelRatio for sharp rendering.
> 6. Maintain a `currentPage` state that updates as the user scrolls (use IntersectionObserver on each page canvas)
> 7. Show a loading spinner while the PDF loads
> 8. Handle errors with a user-friendly error message
> 
> The scrollable container must have `overflow-y: auto` and a dark background `#141414`. Add 16px padding between pages."

---

### Step 3.3 — PDF Viewer Toolbar

**Prompt for Copilot:**
> "Create `src/renderer/components/workspace/pdf/PDFToolbar.tsx`. It renders above the PDF canvas area and contains:
> - Left group: tool buttons — Highlight (with color picker dropdown: yellow, green, pink, blue), Sticky Note, Text Box, Draw, Image Stamp, Eraser. Use lucide-react icons. Active tool gets a highlighted background.
> - Right group: Zoom Out button, zoom percentage display (e.g., '100%'), Zoom In button
> - Accept props: `activeTool`, `onToolChange`, `zoomLevel`, `onZoomChange`
> - Height 44px, background `#1e1e1e`, border-bottom `1px solid #2a2a2a`
> - Buttons: 32px × 32px, icon size 16px, rounded corners, hover `#2a2a2a`"

---

### Step 3.4 — Text Selection Floating Action Bar

**Prompt for Copilot:**
> "Create `src/renderer/components/workspace/FloatingActionBar.tsx`. This is an absolute-positioned overlay that appears above any text selection in the PDF or Notes panel.
>
> Behavior:
> - Listen for `mouseup` events on the PDF canvas container
> - Call `window.getSelection()` to detect if text is selected and get the selection rect
> - If selection is non-empty, position the bar 8px above the selection bounding rect
> - The bar contains three buttons: `Highlight ▾` (with color dropdown), `Send to Claude ▾` (dropdown showing Claude, ChatGPT, Gemini), `Save to Notes`
> - Disappear on `mousedown` outside the bar
>
> The bar itself: `background: #2d2d2d`, `border: 1px solid #444`, `border-radius: 8px`, `padding: 4px 8px`, `box-shadow: 0 4px 12px rgba(0,0,0,0.5)`, `z-index: 1000`
> 
> On 'Send to [AI]': dispatch a custom event `sendToAI` with `{ text: selectedText, target: 'claude' | 'chatgpt' | 'gemini' }`
> On 'Save to Notes': dispatch `saveToNotes` with `{ text: selectedText, sourcePage: currentPage, sourceFile: filePath }`"

---

### Step 3.5 — PDF Annotation Layer (Phase 3 scope: Highlight + Sticky Note only)

**Prompt for Copilot:**
> "Create `src/renderer/components/workspace/pdf/AnnotationLayer.tsx`. This is an absolutely-positioned transparent div overlaid on top of each PDF page canvas (same dimensions, `position: absolute, top: 0, left: 0`).
>
> Implement Highlight tool:
> - When `activeTool === 'highlight'` and user makes a text selection over the canvas, capture the selection rects
> - Render highlight rectangles as semi-transparent colored divs (`opacity: 0.3`) over the selection area
> - On save: serialize annotation to `{ type: 'highlight', page, rects, color, text }` and call `annotationStore.save(fileId, annotation)`
>
> Implement Sticky Note tool:
> - When `activeTool === 'sticky'` and user clicks on the page, place a small 📌 icon at that position
> - Clicking the icon opens a small popover textarea for the note content
> - Render the popover with `background: #fffde7`, `border-radius: 8px`, `padding: 12px`, `min-width: 200px`, `box-shadow: 0 4px 16px rgba(0,0,0,0.5)`
>
> Store annotations in SQLite via IPC. Load and re-render saved annotations when a page loads."

**Debug checkpoint for Phase 3:**
- [ ] Open a PDF from vault — renders correctly with virtualization (offscreen pages are placeholders)
- [ ] Zoom in/out changes canvas scale
- [ ] Text selection shows FloatingActionBar in correct position
- [ ] Highlight tool: select text, highlight renders as colored overlay
- [ ] Sticky note: click on page, icon appears, click icon opens popover
- [ ] Annotations persist after closing and reopening the PDF
- [ ] `currentPage` updates as you scroll
- [ ] 100+ page PDFs scroll smoothly with limited canvases mounted

---

## Phase 4 — Workspace: Notes Editor *(NOT STARTED)*

> **Status:** This is the next phase to implement. No `NotesEditor.tsx` exists yet.

### Step 4.0 — Install Notes Dependencies

**Prompt for Copilot:**
> "Install the following dependencies for the Notes Editor:
> - `@codemirror/state` `@codemirror/view` `@codemirror/lang-markdown` `@codemirror/language` `@codemirror/commands` `@codemirror/autocomplete`
> - `@codemirror/theme-one-dark` (dark theme)
> - `react-markdown` + `remark-gfm` (read mode rendering)
> - `@lezer/markdown` (CodeMirror markdown parser)
>
> These are all dev/runtime dependencies for the renderer process, no native modules needed."

---

### Step 4.1 — Notes IPC Handlers

**Prompt for Copilot:**
> "Add notes CRUD IPC handlers to the existing codebase. These are needed before the UI can work.
>
> In `src/shared/ipc/channels.ts`, add a `NOTES_CHANNELS` object:
> ```ts
> export const NOTES_CHANNELS = {
>   CREATE:  'notes:create',
>   READ:    'notes:read',
>   UPDATE:  'notes:update',
>   LIST:    'notes:list',
>   DELETE:  'notes:delete',
> } as const;
> ```
>
> In `src/main/ipc/notesHandlers.ts` (new file), implement:
> - `notes:create(vaultPath, subject, title)` — creates a `.md` file on disk at `{vaultPath}/{subject}/{title}.md`, inserts a record into the `notes` SQLite table, returns `{ id, path }`
> - `notes:read(vaultPath, noteId)` — fetches note record from SQLite, reads file content from disk, returns `{ id, title, content, subject, source_file_id, source_page }`
> - `notes:update(vaultPath, noteId, content)` — writes content to the `.md` file on disk, updates `updated_at` in SQLite
> - `notes:list(vaultPath)` — returns all `NoteSummary[]` from SQLite
> - `notes:delete(vaultPath, noteId)` — deletes file from disk + SQLite record
>
> Register the handlers in `src/main/index.ts` alongside the existing vault/search/annotation handlers.
> Add the corresponding methods to `src/preload/index.ts` electronAPI object.
> Add typed contracts to `src/shared/ipc/contracts.ts`."

---

### Step 4.2 — Notes Editor Core

**Prompt for Copilot:**
> "Create `src/renderer/components/workspace/notes/NotesEditor.tsx` using CodeMirror 6.
>
> Props: `filePath: string`, `noteId: string`, `vaultPath: string`
>
> Setup:
> - Use `@codemirror/lang-markdown` with full markdown extensions
> - Dark theme using `@codemirror/theme-one-dark` customized to match app (background `#141414`, gutter `#1a1a1a`)
> - Font: system monospace (`'JetBrains Mono', 'Fira Code', 'Consolas', monospace`), 14px
>
> Three view modes (toggle buttons in top-right corner of the editor area):
> 1. **Edit mode**: Raw CodeMirror editor, always shows markdown syntax
> 2. **Live Preview mode** (default): CodeMirror with markdown decorations — renders inline formatting (bold, italic, links, headings) while editing. Only shows raw syntax on the line the cursor is on.
> 3. **Read mode**: Hide CodeMirror, render content as HTML using `react-markdown` with `remark-gfm` (tables, strikethrough, task lists). Not editable.
>
> Mode toggle: three small buttons (Edit | Live | Read) styled as a segmented control. Background `#252525`, active segment `#3a3a3a`, text `#d4d4d4`.
>
> Keyboard shortcut: `Ctrl+E` cycles Edit → Live → Read → Edit.
>
> Autosave: debounce content changes by 1000ms, then call `electronAPI.updateNote(vaultPath, noteId, content)`.
>
> Load note content on mount via `electronAPI.readNote(vaultPath, noteId)`."

---

### Step 4.3 — Workspace Integration for Notes

**Prompt for Copilot:**
> "Modify `src/renderer/components/workspace/Workspace.tsx` to handle `.md` files.
>
> Currently, `renderContent()` only handles `fileType === 'pdf'`. Add a case for `fileType === 'md'`:
> ```tsx
> if (activeFile.fileType === 'md') {
>   return (
>     <div className='flex-1 min-h-0 overflow-hidden'>
>       <NotesEditor
>         key={activeFile.filePath}
>         filePath={activeFile.filePath}
>         noteId={activeFile.fileId ?? ''}
>         vaultPath={vaultPath ?? ''}
>       />
>     </div>
>   );
> }
> ```
>
> Import NotesEditor at the top of the file."

---

### Step 4.4 — New Note Button in Vault Sidebar

**Prompt for Copilot:**
> "Modify `src/renderer/components/vault/VaultSidebar.tsx`:
>
> The '+ New Note' button already exists visually at the top of the sidebar. Wire it to actually create a note:
> 1. On click: call `electronAPI.createNote(vaultPath, subject, 'Untitled Note')` where `subject` is the current expanded folder name (or empty if none)
> 2. On success: dispatch an `openFile` event with the new note's path and `fileType: 'md'`
> 3. Refresh the file tree after creation
>
> Also: ensure `.md` files in the file tree open in the NotesEditor when clicked (the `onFileClick` handler should set `fileType: 'md'` for markdown files)."

---

### Step 4.5 — Pinned Reference Strip

**Prompt for Copilot:**
> "Create `src/renderer/components/workspace/notes/PinnedReferenceStrip.tsx`.
>
> This is a slim bar (height 36px) pinned at the top of the notes editor content area (below the mode toggle buttons).
>
> Props: `sourceFileName: string | null`, `sourcePage: number | null`, `onNavigate: () => void`, `onDismiss: () => void`
>
> It shows: `📄 {fileName} — Page {pageNumber}` with an × dismiss button on the right.
>
> Behavior:
> - Visible only when both `sourceFileName` and `sourcePage` are non-null
> - Clicking the strip text calls `onNavigate()` which dispatches an `openFile` event to open the source PDF at that page
> - Clicking × calls `onDismiss()` to hide the strip
>
> Style: `background: #252525`, `border-bottom: 1px solid #333`, `font-size: 12px`, `color: #888`, clickable text turns `#ccc` on hover."

---

### Step 4.6 — Exam Templates

**Prompt for Copilot:**
> "Add a Templates dropdown button to the NotesEditor toolbar area (next to the mode toggle buttons).
>
> When clicked, show a dropdown with these options:
> - 2-mark definition
> - 5-mark answer
> - 10-mark answer
> - Comparison table
> - Formula sheet block
>
> Clicking a template inserts the corresponding markdown template at the cursor position in CodeMirror. Templates:
> - **2-mark**: `## [Term]\n**Definition:** \n\n**Example:** `
> - **5-mark**: `## [Topic]\n\n**Key Points:**\n1. \n2. \n3. \n\n**Explanation:**\n\n**Example:**`
> - **10-mark**: `## [Topic]\n\n### Introduction\n\n### Main Points\n\n#### 1. [Point]\n- Sub-point\n- Sub-point\n\n#### 2. [Point]\n- Sub-point\n- Sub-point\n\n#### 3. [Point]\n- Sub-point\n- Sub-point\n\n### Comparison\n| Aspect | A | B |\n|--------|---|---|\n| | | |\n\n### Conclusion\n`
> - **Comparison table**: `| Topic | A | B |\n|-------|---|---|\n| | | |\n| | | |\n| | | |`
> - **Formula sheet**: `` ```math\n% Formula Sheet\n% Add formulas below\n\n``` ``
>
> Use CodeMirror's `dispatch` and `replaceSelection` to insert at cursor."

---

### Step 4.7 — Wire "Save to Notes" from Floating Action Bar

**Prompt for Copilot:**
> "The FloatingActionBar in `src/renderer/components/workspace/FloatingActionBar.tsx` has a 'Save to Notes' button that dispatches a `saveToNotes` custom event, but nothing listens for it.
>
> Add a listener in `Workspace.tsx` or the `NotesEditor`:
> 1. Listen for the `saveToNotes` event
> 2. On event, show a small dropdown/modal asking: create new note or append to existing note
> 3. If 'new note': call `electronAPI.createNote()` with the selected text as initial content, set `source_file_id` and `source_page` from the event detail
> 4. If 'append to existing': call `electronAPI.readNote()` → append text with `\n\n---\n### Saved from PDF — Page {page}\n{text}\n---\n` → call `electronAPI.updateNote()`
> 5. Open the note in the workspace after saving"

**Debug checkpoint for Phase 4:**
- [ ] Notes dependencies install without errors
- [ ] `notes:create` IPC creates `.md` file on disk + SQLite record
- [ ] Clicking '+ New Note' in sidebar creates and opens a note
- [ ] Notes editor opens in Live Preview mode by default
- [ ] `Ctrl+E` cycles through Edit → Live → Read modes
- [ ] Read mode renders markdown correctly (headings, tables, code blocks, task lists)
- [ ] Autosave writes file to disk after 1 second of no typing
- [ ] `.md` files in sidebar open in NotesEditor (not PDFViewer)
- [ ] Pinned reference strip appears for notes with source links
- [ ] Clicking reference strip opens the source PDF at the correct page
- [ ] Templates insert correct markdown at cursor position
- [ ] "Save to Notes" from FloatingActionBar creates note with source reference

---

## Phase 5 — Search Engine *(NOT STARTED)*

> **Status:** Not yet implemented. Spotlight search, full hybrid search, and search handlers all need to be built.

---

## Phase 6 — AI Panel (Webview Integration) *(NOT STARTED)*

> **Status:** Not yet implemented. Only a placeholder component exists — no webviews.

### Step 6.1 — Webview Setup with Persistent Sessions

**Prompt for Copilot:**
> "Replace the placeholder in `src/renderer/components/ai/AIPanel.tsx` with actual webview integration:
>
> 1. Render a tab bar with three tabs: ChatGPT (green accent `#10a37f`), Claude (orange accent `#da7756`), Gemini (blue accent `#4285f4`). Active tab shows the color accent as a bottom border and slightly highlighted background.
>
> 2. For each AI, render an Electron `<webview>` tag:
>    ```html
>    <webview partition='persist:chatgpt' src='https://chatgpt.com' />
>    <webview partition='persist:claude' src='https://claude.ai' />
>    <webview partition='persist:gemini' src='https://gemini.google.com' />
>    ```
>
> 3. Only the active tab's webview is visible (`display: block`). Others are `display: none` but remain mounted (preserves session).
>
> 4. Set a standard Chrome user-agent on each webview via the `useragent` attribute:
>    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36`
>
> 5. Webviews must fill the full available height of the panel below the tab bar.
>
> 6. Note: The webview CSP session tweaks are already in `src/main/index.ts` (`setupWebviewSessions()`), and `webviewTag: true` is already set in `BrowserWindow.webPreferences`."

---

### Step 6.2 — Send to AI Flow

**Prompt for Copilot:**
> "Implement the 'Send to AI' flow. The FloatingActionBar already dispatches a `sendToAI` custom event with `{ text, target: 'claude' | 'chatgpt' | 'gemini' }`.
>
> In AIPanel:
> 1. Listen for the `sendToAI` event
> 2. Switch to the matching AI tab
> 3. Attempt to inject text into the AI's input field via `webview.executeJavaScript()`
> 4. Implement a 3-stage fallback pipeline:
>    - Stage 1: DOM injection — find the target input/textarea and set its value
>    - Stage 2: Synthetic paste event — dispatch clipboard paste event
>    - Stage 3: Clipboard fallback — copy text to clipboard, show toast 'Text copied to clipboard — paste it into the AI chat'
> 5. Keep centralized selector configs per provider for easy updates when AI sites change their DOM."

---

### Step 6.3 — Save from AI to Notes

**Prompt for Copilot:**
> "Add a 'Save to Notes' pill button fixed at the top-right of the AI panel (above the active webview).
>
> On click:
> 1. Call `activeWebviewRef.executeJavaScript('window.getSelection().toString()')` to get selected AI text
> 2. If no selection, show a tooltip 'Select text in the AI chat first'
> 3. If selection found, show an inline dropdown:
>    - Subject field auto-filled with current vault's active subject
>    - Note selector dropdown of existing notes (from SQLite) + 'Create new note' option
>    - Confirm button
> 4. On confirm, append to selected note:
>    ```markdown
>    ---
>    ### [Saved from AI] — {formatted date and time}
>    {selected AI text}
>    ---
>    ```
> 5. Show a success toast: 'Saved to {note name}'"

**Debug checkpoint for Phase 6:**
- [ ] All three AI tabs load their respective websites
- [ ] Switching tabs shows correct AI, session is preserved (no logout)
- [ ] Highlight PDF text → FloatingActionBar → 'Send to Claude' → text appears in Claude's input (or clipboard fallback works)
- [ ] Select AI response text → 'Save to Notes' → content appended to `.md` file on disk
- [ ] Console: no CSP errors blocking webview loads

---

## Phase 7 — Annotation Completion *(NOT STARTED)*

> **Status:** Not yet implemented. Annotation re-indexing pipeline and image stamp tool need to be built.

### Step 7.1 — Annotation Re-indexing Pipeline

**Prompt for Copilot:**
> "In `src/main/indexing/indexer.ts`, add `reindexAnnotations(fileId: string, page: number, vaultPath: string): Promise<void>`:
> 1. Load all annotations for that file+page from the annotations SQLite table
> 2. Collect all text content: highlight text, sticky note text, text box content
> 3. Delete existing annotation chunks: `DELETE FROM chunks WHERE file_id = ? AND page_or_slide = ? AND is_annotation = 1`
> 4. Insert new annotation chunks with `is_annotation = 1` flag
> 5. Update FTS5 virtual table
> 6. Re-generate embeddings for those chunks via `embedBatch`
> 7. Upsert new vectors in LanceDB
>
> Call this silently after every annotation save — no loading indicator."

---

### Step 7.2 — Image Stamp Tool

**Prompt for Copilot:**
> "Extend `AnnotationLayer.tsx` to implement the image stamp tool:
> - When `activeTool === 'image'` and user clicks on the page, open a native file dialog to pick an image
> - Render the image at click position as an `<img>` element, draggable and resizable via corner handles
> - Store as `{ type: 'image', page, x, y, width, height, dataUrl }` (convert image to base64 data URL)
>
> Add `ImageAnnotation` type to `src/shared/types.ts`:
> ```ts
> export type ImageAnnotation = AnnotationBase & {
>   type: 'image';
>   x: number;
>   y: number;
>   width: number;
>   height: number;
>   dataUrl: string;
> };
> ```
>
> Update the `Annotation` union type to include `ImageAnnotation`."

**Debug checkpoint for Phase 7:**
- [ ] After annotating a PDF page, search for annotation text — it surfaces in search results with `is_annotation` boost
- [ ] Image stamp: pick image → appears on page → survives page scroll and app restart
- [ ] Image stamp is draggable and resizable

---

## Phase 8 — Polish, Keyboard Shortcuts & Performance

### Step 8.1 — Global Keyboard Shortcuts

**Prompt for Copilot:**
> "Register these keyboard shortcuts throughout the app using a `useKeyboardShortcut(key, callback)` hook in `src/renderer/hooks/useKeyboardShortcut.ts`:
> - `Ctrl+K` — open Spotlight search (already done, verify global)
> - `Ctrl+E` — toggle Notes editor mode (handled in NotesEditor)
> - `Ctrl+[` — collapse/expand Vault sidebar
> - `Ctrl+]` — collapse/expand AI panel
> - `Ctrl+N` — create new note in current subject
> - `Ctrl+W` — close current file tab
> - `Ctrl+1/2/3` — switch workspace tabs
>
> Register shortcuts at the AppLayout level so they work regardless of focus."

---

### Step 8.2 — Full Search Results UI

**Prompt for Copilot:**
> "Create `src/renderer/components/search/FullSearchResults.tsx` — renders as a workspace view (opened via `Ctrl+F` or from Spotlight 'See all results' link).
>
> UI:
> - Filter bar at top: Subject dropdown, File Type dropdown (All / PDF / Notes / PPTX), Sort by (Relevance / Date)
> - Results list: each result card shows file name, subject badge, page/slide number pill, text snippet (bold matching terms), score indicator
> - Clicking a result opens the file at that page in PDF viewer or the note in NotesEditor
>
> Uses `electronAPI.fullSearch()` which is already implemented."

---

### Step 8.3 — Loading States & Skeleton Screens

**Prompt for Copilot:**
> "Add loading states to every async operation:
> - Vault opening: show a progress bar with 'Indexing files... {n}/{total}' text (IPC progress events already exist via `onIndexProgress`)
> - PDF loading: show a page-shaped skeleton with shimmer animation while PDF.js loads
> - Search: show 3 skeleton result cards while searching
> - AI webview first load: show a spinner overlay until `did-finish-load` fires
> - Embedder initialization: show a one-time 'Setting up AI search...' banner in the status bar area"

---

### Step 8.4 — Toast Notification System

**Prompt for Copilot:**
> "Create `src/renderer/components/ui/ToastProvider.tsx` using React context. Toasts appear in the bottom-right corner, stack vertically, auto-dismiss after 3 seconds, dismissible manually.
>
> Toast types: `success` (green left border), `error` (red left border), `info` (blue left border), `warning` (yellow left border).
>
> Export a `useToast()` hook: `{ toast: (message: string, type?: ToastType) => void }`.
>
> Style: `background: #2d2d2d`, `border-radius: 8px`, `padding: 10px 16px`, `box-shadow: 0 4px 16px rgba(0,0,0,0.4)`, max-width 320px, slide-in animation from right."

---

### Step 8.5 — Performance Optimization

**Prompt for Copilot:**
> "Apply these performance improvements:
>
> 1. **Vault sidebar virtualization**: If vault has more than 100 files, use a virtual list (implement with `position: absolute` and calculated offsets).
>
> 2. **Embedding queue**: In `src/main/workers/embedder.ts`, implement a queue with concurrency limit of 1. If indexing is triggered while already indexing, queue the new file. Show overall queue progress via IPC.
>
> 3. **Memoization**: Wrap the VaultSidebar file tree with `React.memo`. Memoize the file list with `useMemo` so it only recomputes when vault contents change."

**Debug checkpoint for Phase 8:**
- [ ] All keyboard shortcuts work from any focused element
- [ ] Full search results view renders with filters
- [ ] Vault with 50+ PDFs: indexing shows accurate progress bar
- [ ] PDF with 100+ pages: scroll performance is smooth (60fps)
- [ ] Search results appear within 200ms for keyword queries
- [ ] Toast appears after Save from AI, auto-dismisses

---

## Phase 9 — PDF Export Engine

### Step 9.1 — Note to PDF Exporter

**Prompt for Copilot:**
> "Create `src/main/export/noteExporter.ts`. Export `exportNoteToPDF(noteId: string, vaultPath: string, outputPath: string): Promise<void>`:
>
> 1. Fetch note content and metadata from SQLite
> 2. Parse markdown to structured AST
> 3. Use `pdf-lib` to create a new PDF document with:
>    - Page size: A4
>    - Margins: 72pt (1 inch) all sides
>    - Header: Subject name left, note title center, page number right
>    - Footer: 'Generated by Axiom' left, date right
>    - Font: embed Helvetica for body, Helvetica-Bold for headings
>    - Heading hierarchy: H1 = 20pt bold, H2 = 16pt bold, H3 = 13pt bold, body = 11pt
>    - Code blocks: monospace font, light gray background rectangle
>    - Tables: rendered as bordered grids
>    - Line spacing: 1.5×
> 4. Save to outputPath
>
> Add IPC handler `notes:exportToPDF(vaultPath, noteId)` — opens save dialog, calls exporter.
> Add an 'Export as PDF' button to the NotesEditor toolbar."

**Debug checkpoint:**
- [ ] Export a note with headings, bullet lists, a table, and a code block
- [ ] Open resulting PDF — verify layout, fonts, page numbers correct

---

## Phase 10 — Beta Testing & Final Integration

### Step 10.1 — End-to-End Integration Test

**Manual test script — run through this entire flow:**

```
1. VAULT SETUP
   [ ] Open app → click 'Open Vault' → select a folder with 5+ PDFs and 2+ markdown files
   [ ] Sidebar renders all files correctly grouped by subfolder
   [ ] Wait for indexing to complete — progress bar reaches 100%
   [ ] Check .axiom folder created: axiom.db, vectors/ folder

2. PDF WORKFLOW
   [ ] Click a PDF — it opens in PDF Viewer
   [ ] Scroll through all pages — no blank pages, no performance lag
   [ ] Select text → FloatingActionBar appears
   [ ] Highlight selected text in yellow → highlight renders, persists on scroll
   [ ] Place a sticky note → note saves, visible on reload
   [ ] Draw on page → path saved and redraws on reload

3. NOTES WORKFLOW
   [ ] Create new note via '+ New Note' button
   [ ] Type markdown: # Heading, bullet list, **bold**, `code`, a table
   [ ] Live Preview renders inline while typing
   [ ] Ctrl+E → Read mode → full render
   [ ] Ctrl+E again → Edit mode
   [ ] Check file saved on disk (correct .md file content)
   [ ] Insert an exam template → correct markdown inserted
   [ ] Select PDF text → Save to Notes → note created with source reference

4. SEARCH WORKFLOW
   [ ] Ctrl+K → Spotlight → type a term from an indexed PDF → result appears
   [ ] Click result → PDF opens at correct page
   [ ] Full Search → type concept not verbatim in docs → semantic results appear
   [ ] Annotate a page, search for annotation text → annotated page appears boosted

5. AI PANEL WORKFLOW
   [ ] All three AI tabs load (may need login on first use)
   [ ] Switching tabs preserves session
   [ ] Highlight PDF text → Send to Claude → text injected or clipboard fallback
   [ ] Select Claude response → Save to Notes → content in correct note file

6. EXPORT
   [ ] Open a note → Export as PDF → save dialog → verify format

7. KEYBOARD SHORTCUTS
   [ ] Ctrl+K, Ctrl+E, Ctrl+[, Ctrl+], Ctrl+N, Ctrl+W all work
```

---

### Step 10.2 — Error Handling Audit

**Prompt for Copilot:**
> "Add error boundaries to these components: PDFViewer, NotesEditor, AIPanel, VaultSidebar. Each ErrorBoundary should render a minimal error card with the error message and a 'Try Again' button.
>
> Also add specific error handlers:
> - `indexFile` failure: log error, mark file as `indexed_at = -1`, continue with next file
> - Webview load failure: show 'Failed to load [AI name].' overlay with retry button
> - PDF parse failure: show 'Could not read this PDF.' message in viewer
> - LanceDB failure: fall back to FTS5-only search, show warning toast"

---

### Step 10.3 — Build Configuration

**Prompt for Copilot:**
> "Configure `forge.config.ts` for distribution builds:
> - Windows: `.exe` NSIS installer, set app icon to `assets/icon.ico`
> - Set `productName: 'Axiom'`, `appId: 'com.axiom.studyos'`
> - Configure `electron-rebuild` to rebuild native modules (better-sqlite3) for the Electron version
> - Add a `postinstall` npm script that runs `electron-rebuild` automatically"

---

## Appendix: Current Status Quick Reference

| Phase | Component | Status |
|-------|-----------|--------|
| 1.1 | Main Window Config | ✅ Done |
| 1.2 | Preload IPC Bridge | ✅ Done |
| 1.3 | Three-Panel Layout | ✅ Done |
| 1.4 | Top Bar (in title bar) | ✅ Done |
| 2.1 | Database Schema | ✅ Done |
| 2.2 | LanceDB Vector Store | ✅ Done |
| 2.3 | Embeddings Worker | ✅ Done |
| 2.4 | File Indexing Pipeline | ✅ Done |
| 2.5 | Vault Watcher | ✅ Done |
| 2.6 | Vault Sidebar | ✅ Done |
| 2.7 | Typed IPC Contracts | ✅ Done |
| 2.8 | IPC Vault Handlers | ✅ Done |
| 3.1 | Workspace Tabs | ✅ Done |
| 3.2 | PDF.js Renderer | ✅ Done |
| 3.3 | PDF Toolbar | ✅ Done |
| 3.4 | Floating Action Bar | ✅ Done |
| 3.5 | Annotation Layer | ✅ Done |
| **4.1** | **Notes IPC** | ❌ Not Started |
| **4.2** | **Notes Editor (CodeMirror)** | ❌ Not Started |
| **4.3** | **Workspace Notes Integration** | ❌ Not Started |
| **4.4** | **New Note Button** | ❌ Not Started |
| **4.5** | **Pinned Reference Strip** | ❌ Not Started |
| **4.6** | **Exam Templates** | ❌ Not Started |
| **4.7** | **Save to Notes Flow** | ❌ Not Started |
| **5.1** | **Spotlight Search** | ❌ Not Started |
| **5.2** | **Full Search Results UI** | ❌ Not Started |
| **5.3** | **IPC Search Handlers** | ❌ Not Started |
| **6.1** | **AI Webviews** | ❌ Not Started |
| **6.2** | **Send to AI Flow** | ❌ Not Started |
| **6.3** | **Save from AI** | ❌ Not Started |
| **7.1** | **Annotation Re-indexing** | ❌ Not Started |
| **7.2** | **Image Stamp Tool** | ❌ Not Started |
| **8–10** | **Polish / Export / Testing** | ❌ Not Started |

---

## Appendix: Common Debugging Reference

| Symptom | Most likely cause | Fix |
|---|---|---|
| White flash on app start | Window shown before React mounts | Add `show: false`, show on `ready-to-show` |
| PDF pages blurry | Not scaling canvas by `devicePixelRatio` | Multiply canvas width/height by `window.devicePixelRatio` |
| SQLite SQLITE_BUSY error | Multiple writes without transaction | Wrap batch inserts in `BEGIN TRANSACTION / COMMIT` |
| LanceDB table not found error | Race condition on first open | Add existence check before open, create if missing |
| Embedder out of memory | Processing too many chunks at once | Reduce batch size to 4 in `embedBatch` |
| Webview blank / CSP error | AI site blocking embedded iframe | Ensure user-agent is set; check `session.webRequest` handler |
| FloatingActionBar in wrong position | Selection rects from wrong coordinate space | Use `getBoundingClientRect()` relative to the scroll container, not viewport |
| Annotations lost after PDF write-back | pdf-lib overwriting existing annotations | Use `PDFDocument.load(existingBytes)`, append don't replace |
| FTS5 search returns nothing | FTS5 table not populated after indexing | Manually run `INSERT INTO chunks_fts SELECT...` after chunk insert |
| Chokidar not detecting changes | Path not watched correctly | Log `watcher.getWatched()` to verify paths |

---

*This plan covers all phases of the Axiom spec. Implement phases in order — each phase builds on the last. Never start a new phase until all debug checkpoints in the current phase pass.*

