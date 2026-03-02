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

## Phase 4 — Workspace: Notes Editor

### Step 4.1 — Notes Editor Core

**Prompt for Copilot:**
> "Create `src/renderer/components/workspace/notes/NotesEditor.tsx` using CodeMirror 6.
>
> Setup:
> - Use `@codemirror/lang-markdown` with full markdown extensions
> - Dark theme using `@codemirror/theme-one-dark` or a custom dark theme matching the app (background `#141414`)
> - Font: `JetBrains Mono` or `monospace`, 14px
>
> Three view modes (toggle buttons in top-right corner):
> 1. **Edit mode**: Raw CodeMirror editor, always shows markdown syntax
> 2. **Live Preview mode** (default): CodeMirror with `@codemirror/lang-markdown` mixed mode — renders markdown inline, only shows raw syntax on the line the cursor is on. Implement this by subscribing to cursor position and toggling decoration.
> 3. **Read mode**: Hide the editor entirely, render content as HTML using `react-markdown` with `remark-gfm`. Not editable.
>
> Keyboard shortcut: `Ctrl+E` toggles between Edit and Read modes.
>
> Autosave: debounce content changes by 1000ms, then call `electronAPI.writeFile(notePath, content)` and update `updated_at` in SQLite."

---

### Step 4.2 — Pinned Reference Strip

**Prompt for Copilot:**
> "Create `src/renderer/components/workspace/notes/PinnedReferenceStrip.tsx`.
>
> This is a slim bar (height 36px) pinned at the top of the notes editor content area (below the mode toggle buttons).
>
> It shows: `📄 {fileName} — Page {pageNumber}` with an × dismiss button on the right.
>
> Behavior:
> - It appears when a note has a `source_file_id` and `source_page` set
> - Clicking the strip text dispatches an `openFileAtPage` event to the Workspace to open that PDF at that page
> - Clicking × sets `source_page` to null (hides the strip)
>
> Style: `background: #252525`, `border-bottom: 1px solid #333`, `font-size: 12px`, `color: #888`, clickable text turns `#ccc` on hover."

---

### Step 4.3 — Notes List Panel (inside Vault Sidebar)

**Prompt for Copilot:**
> "Extend `VaultSidebar.tsx` to show notes in the file tree. Notes (`.md` files) should appear under their subject folder. Clicking a note opens it in the Notes editor tab.
>
> Add a '+ New Note' button at the top of the sidebar. Clicking it:
> 1. Creates a new `.md` file in the vault's current subject folder with name `Untitled Note {timestamp}.md`
> 2. Inserts a record into the `notes` SQLite table
> 3. Opens the new note in the editor and focuses the title area"

---

### Step 4.4 — Exam Templates

**Prompt for Copilot:**
> "Add a Templates dropdown button to the NotesEditor toolbar. When clicked, show a dropdown with these options:
> - 2-mark definition
> - 5-mark answer
> - 10-mark answer
> - Comparison table
> - Formula sheet block
>
> Clicking a template inserts the corresponding markdown template at the cursor position in CodeMirror. Templates:
> - **2-mark**: `## [Term]\n**Definition:** \n\n**Example:** `
> - **5-mark**: `## [Topic]\n\n**Key Points:**\n1. \n2. \n3. \n\n**Explanation:**\n\n**Example:**`
> - **10-mark**: includes intro, 3 main points with sub-points, comparison, conclusion
> - **Comparison table**: markdown table with columns Topic | A | B
> - **Formula sheet**: fenced code block with latex comment header"

**Debug checkpoint for Phase 4:**
- [ ] New note creates a `.md` file on disk
- [ ] Notes editor opens in Live Preview mode by default
- [ ] `Ctrl+E` toggles between Edit and Read
- [ ] Read mode renders markdown correctly (headings, tables, code blocks)
- [ ] Autosave writes file to disk after 1 second of no typing
- [ ] Pinned reference strip appears for notes with source links
- [ ] Clicking reference strip opens the source PDF at the correct page
- [ ] Templates insert correct markdown at cursor position

---

## Phase 5 — Search Engine

### Step 5.1 — Spotlight Search (Ctrl+K)

**Prompt for Copilot:**
> "Create `src/renderer/components/search/SpotlightSearch.tsx`. This is a modal overlay triggered by `Ctrl+K`.
>
> UI:
> - Full-screen dark overlay (`rgba(0,0,0,0.7)`) with a centered search card
> - Card: `width: 600px`, `background: #1e1e1e`, `border: 1px solid #3a3a3a`, `border-radius: 12px`, `box-shadow: 0 16px 48px rgba(0,0,0,0.8)`
> - Input at top of card: large, no border, dark background, white text, auto-focused on open
> - Results list below input, max 8 results, keyboard-navigable with arrow keys
> - Each result shows: file type icon, file name, subject label, text snippet (max 80 chars)
> - Press Enter or click a result to open it. Press Escape to close.
>
> Search logic (via IPC `search:spotlight`):
> - Query `chunks_fts` SQLite FTS5 with `MATCH ?` for keyword results
> - Also search `notes` table title and content
> - Debounce input by 150ms for responsiveness
> - Return top 8 results ranked by BM25 score (`rank` column in FTS5)"

---

### Step 5.2 — Full Search Results

**Prompt for Copilot:**
> "Create `src/renderer/components/search/FullSearchResults.tsx` — this renders as the 'Search Results' tab in the Workspace.
>
> UI:
> - Filter bar at top: Subject dropdown, File Type dropdown (All / PDF / Notes / PPTX), Sort by (Relevance / Date)
> - Results list: each result card shows file name, subject badge, page/slide number pill, highlighted text snippet (bold the matching terms), and a small score indicator
> - Clicking a result: opens the file at that page in the PDF viewer (or opens the note), AND switches Workspace to that mode
> - 'Back' button in top-left returns to search results without losing them
>
> Search logic (via IPC `search:full`):
> - Run SQLite FTS5 BM25 keyword search
> - Run LanceDB cosine similarity semantic search (embed query first using the embedder)
> - Merge results: score = (0.4 × BM25_normalized) + (0.6 × cosine_similarity)
> - Boost score ×1.5 if result is from a note (user's own writing)
> - Boost score ×1.3 if result is from an annotation (user marked it important)
> - Return top 20 merged results"

---

### Step 5.3 — IPC Search Handlers

**Prompt for Copilot:**
> "In `src/main/ipc/searchHandlers.ts`, implement:
>
> `search:spotlight(query)`:
> - Run: `SELECT chunks.*, files.name, files.type, files.subject FROM chunks_fts JOIN chunks ON chunks.rowid = chunks_fts.rowid JOIN files ON files.id = chunks.file_id WHERE chunks_fts MATCH ? ORDER BY rank LIMIT 8`
> - Also run: `SELECT * FROM notes WHERE title LIKE ? OR content LIKE ? LIMIT 4`
> - Merge and return
>
> `search:full(query)`:
> - FTS5 keyword search: same as above but LIMIT 50
> - Semantic search: embed query → LanceDB search → top 30 results
> - Merge by chunk ID, compute hybrid score, sort descending, return top 20
> - Support filter params: subject, fileType
>
> Include timing logs for each step (FTS5 ms, semantic ms, merge ms) to diagnose performance."

**Debug checkpoint for Phase 5:**
- [ ] `Ctrl+K` opens Spotlight, `Escape` closes it
- [ ] Typing in Spotlight returns results within 150ms
- [ ] Arrow keys navigate results, Enter opens correct file/page
- [ ] Full search returns results from both PDFs and notes
- [ ] Semantic search finds conceptually related content (test: search 'memory management' and verify 'heap allocation' results appear if indexed)
- [ ] Score boosting: annotated text appears above non-annotated text for same query
- [ ] Filters narrow results correctly

---

## Phase 6 — AI Panel (Reliability-First Webview Integration)

### Step 6.1 — Webview Setup with Persistent Sessions

**Prompt for Copilot:**
> "Create `src/renderer/components/ai/AIPanel.tsx`. It must:
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
> 4. Set a standard Chrome user-agent on each webview via the `useragent` attribute to prevent detection/blocking:
>    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36`
>
> 5. Webviews must fill the full available height of the panel below the tab bar.
>
> 6. Add a 'Save to Notes' pill button (fixed position, top-right of panel): `background: #3a3a3a`, `border-radius: 20px`, `padding: 4px 12px`. It calls `window.getSelection()` on the active webview via `executeJavaScript` and dispatches `saveFromAI` event."

---

### Step 6.2 — Reliability Contract (Mandatory, non-negotiable)

**Prompt for Copilot:**
> "Implement reliability-first behavior for AI webviews so the feature remains usable despite CSP/DOM changes:
>
> Required safeguards:
> - Centralize selectors per provider with versioned strategy list
> - Add provider health checks (`ready`, `degraded`, `offline`) shown in UI
> - Add 3-stage send pipeline: DOM injection attempt → synthetic paste event → clipboard fallback
> - Add timeout + retry with exponential backoff for each stage
> - Emit structured telemetry logs for every failure path (provider, stage, error)
> - Keep 'Send to AI' always functional via guaranteed clipboard fallback + explicit user guidance
>
> Success criteria: user can always transfer selected text to the chosen AI even if direct DOM injection breaks."

---

### Step 6.3 — Save from AI Feature

**Prompt for Copilot:**
> "Implement the 'Save from AI to Notes' flow in `AIPanel.tsx`:
>
> When user clicks 'Save to Notes' pill button:
> 1. Call `activeWebviewRef.executeJavaScript('window.getSelection().toString()')` to get selected AI text
> 2. If no selection, show a tooltip 'Select text in the AI chat first'
> 3. If selection found, show an inline dropdown below the button:
>    - Subject field: auto-filled with the current vault's active subject
>    - Note selector: dropdown of existing notes (fetched from SQLite) + 'Create new note' option
>    - Confirm button
> 4. On confirm: append to the selected note file:
>    ```markdown
>    ---
>    ### [Saved from AI] — {formatted date and time}
>    {selected AI text}
>    ---
>    ```
> 5. Show a success toast: 'Saved to {note name}'"

---

### Step 6.4 — Webview Security Configuration

**Prompt for Copilot:**
> "In `src/main/index.ts`, add a `session.webRequest.onHeadersReceived` handler for the webview partitions ('persist:chatgpt', 'persist:claude', 'persist:gemini'). Modify the Content-Security-Policy header to allow embedding. Also configure `webview` permissions in `BrowserWindow.webPreferences` — set `webviewTag: true`. Add a `will-navigate` event handler on each webview that logs the URL for debugging. Add a `did-fail-load` handler that shows a reload button overlay if a webview fails to load."

---

### Step 6.5 — Deferred DOM Automation (Only after core stability)

**Prompt for Copilot:**
> "Defer provider-specific DOM automation until core vault/search/notes flows are stable.
>
> Gate condition before enabling aggressive automation:
> - Phase 2, 4, and 5 checkpoints are fully green
> - No critical indexing/search errors for at least 3 consecutive manual test runs
>
> Implementation rule:
> - Ship automation behind a feature flag (`ENABLE_AI_DOM_AUTOMATION=false` by default)
> - Keep reliability pipeline from Step 6.2 active regardless of automation flag"

**Debug checkpoint for Phase 6:**
- [ ] All three AI tabs load their respective websites
- [ ] Switching tabs shows correct AI, session is preserved (no logout)
- [ ] Highlight text in PDF → FloatingActionBar → 'Send to Claude' always transfers text (injection or fallback)
- [ ] If injection fails, clipboard fallback works every time (verify by pasting manually)
- [ ] Select AI response text → 'Save to Notes' → dropdown appears → select note → content appended to `.md` file on disk with correct timestamp format
- [ ] Console: no CSP errors blocking webview loads
- [ ] Provider health state is visible and degrades gracefully without breaking user flow

---

## Phase 7 — Full PDF Annotation Suite

### Step 7.1 — Remaining Annotation Tools

**Prompt for Copilot:**
> "Extend `AnnotationLayer.tsx` from Phase 3 to add the remaining tools:
>
> **Text Box tool:**
> - Click on page → render an `<input>` or `<div contenteditable>` at click position
> - On blur, convert to a rendered text annotation div
> - Store: `{ type: 'textbox', page, x, y, text, fontSize: 14, color: '#ffffff' }`
>
> **Freehand Draw tool:**
> - On mousedown: start capturing SVG path points
> - On mousemove: extend the SVG `<polyline>` in real time  
> - On mouseup: save the path as `{ type: 'draw', page, points: [{x,y}], color, strokeWidth: 2 }`
> - Render saved drawings as SVG polylines overlaid on the page
>
> **Image Stamp tool:**
> - Click on page → opens native file dialog to pick an image
> - Render the image at click position, draggable and resizable via corner handles
> - Store: `{ type: 'image', page, x, y, width, height, dataUrl }`
>
> **Eraser tool:**
> - On click/drag: detect which annotation's bounding box is under the cursor, delete it from the store and re-render
>
> **Write-back to PDF:**
> - After any annotation change, call `src/main/pdf/annotationWriter.ts`
> - Use `pdf-lib` to embed highlights, text boxes, and sticky notes as real PDF annotations
> - Freehand draws and image stamps: embed as page content stream elements
> - After write-back, trigger incremental re-indexing of the modified page"

---

### Step 7.2 — Annotation Re-indexing Pipeline

**Prompt for Copilot:**
> "In `src/main/indexing/indexer.ts`, add `reindexAnnotations(fileId: string, page: number, annotations: Annotation[]): Promise<void>`:
> 1. Collect all text from annotations on the given page: highlight text, sticky note text, text box content
> 2. Delete existing annotation chunks for that file+page from SQLite (WHERE `file_id = ? AND page_or_slide = ? AND is_annotation = 1`)
> 3. Insert new annotation chunks with `is_annotation = 1` flag
> 4. Re-generate embeddings for those chunks
> 5. Upsert new vectors in LanceDB
> This must run silently in the background after save — show no loading indicator."

**Debug checkpoint for Phase 7:**
- [ ] Text Box: click on PDF page, type text, text persists after reopening PDF
- [ ] Freehand Draw: draw on page, path saved and redraws on reload
- [ ] Image Stamp: pick image, appears on page, survives app restart
- [ ] Eraser: click on annotation, it disappears
- [ ] Open the annotated PDF in external PDF reader (Preview/Acrobat) — highlights and sticky notes must be visible
- [ ] After annotating, search for annotation text — it surfaces in search results

---

## Phase 8 — Polish, Keyboard Shortcuts & Performance

### Step 8.1 — Global Keyboard Shortcuts

**Prompt for Copilot:**
> "Register these keyboard shortcuts throughout the app:
> - `Ctrl+K` — open Spotlight search (already done, verify global)
> - `Ctrl+E` — toggle Notes editor between Edit and Read mode
> - `Ctrl+[` — collapse/expand Vault sidebar
> - `Ctrl+]` — collapse/expand AI panel
> - `Ctrl+N` — create new note in current subject
> - `Ctrl+F` — focus the top search bar and run Full Search mode
> - `Ctrl+W` — close current file in workspace (return to empty state)
> - `Ctrl+1/2/3` — switch workspace to PDF/Notes/Search tab
> Use a `useKeyboardShortcut(key, callback)` React hook in `src/renderer/hooks/useKeyboardShortcut.ts`. Register shortcuts at the App level so they work regardless of focus."

---

### Step 8.2 — Loading States & Skeleton Screens

**Prompt for Copilot:**
> "Add loading states to every async operation:
> - Vault opening: show a progress bar with 'Indexing files... {n}/{total}' text. Use IPC progress events pushed from main to renderer.
> - PDF loading: show a page-shaped skeleton (gray placeholder rectangles) while PDF.js loads
> - Search: show 3 skeleton result cards with shimmer animation while search runs
> - AI webview first load: show a spinner overlay on the webview until `did-finish-load` fires
> - Embedder initialization: show a one-time 'Setting up AI search...' banner at the bottom of the app (like VS Code's status bar)"

---

### Step 8.3 — Toast Notification System

**Prompt for Copilot:**
> "Create `src/renderer/components/ui/ToastProvider.tsx` using React context. Toasts appear in the bottom-right corner, stack vertically, auto-dismiss after 3 seconds, and can be dismissed manually.
>
> Toast types: `success` (green left border), `error` (red left border), `info` (blue left border), `warning` (yellow left border).
>
> Export a `useToast()` hook: `{ toast: (message: string, type?: ToastType) => void }`.
>
> Style: `background: #2d2d2d`, `border-radius: 8px`, `padding: 10px 16px`, `box-shadow: 0 4px 16px rgba(0,0,0,0.4)`, max-width 320px, slide-in animation from right."

---

### Step 8.4 — Performance Optimization

**Prompt for Copilot:**
> "Apply these performance improvements:
>
> 1. **Vault sidebar virtualization**: If vault has more than 100 files, use a virtual list (implement a simple one with `position: absolute` and calculated offsets).
>
> 2. **Embedding queue**: In `src/main/workers/embedder.ts`, implement a queue with concurrency limit of 1. If indexing is triggered while already indexing, queue the new file. Show overall queue progress in the status bar.
>
> 3. **Memoization**: Wrap the VaultSidebar file tree with `React.memo`. Memoize the file list with `useMemo` so it only recomputes when the vault contents change."

**Debug checkpoint for Phase 8:**
- [ ] All keyboard shortcuts work from any focused element
- [ ] Vault with 50+ PDFs: indexing shows accurate progress bar
- [ ] PDF with 100+ pages: scroll performance is smooth (60fps), only visible pages have canvases in DOM
- [ ] Search results appear within 200ms for keyword queries
- [ ] Semantic search results appear within 1 second
- [ ] Toast appears after Save from AI, auto-dismisses

---

## Phase 9 — PDF Export Engine

### Step 9.1 — Note to PDF Exporter

**Prompt for Copilot:**
> "Create `src/main/export/noteExporter.ts`. Export `exportNoteToPDF(noteId: string, outputPath: string): Promise<void>`:
>
> 1. Fetch note content and metadata from SQLite
> 2. Parse markdown to a structured AST using a markdown parser
> 3. Use `pdf-lib` to create a new PDF document with:
>    - Page size: A4
>    - Margins: 72pt (1 inch) all sides
>    - Header on every page: Subject name left, note title center, page number right (e.g. 'Page 1 of 4')
>    - Footer on every page: 'Generated by Axiom' left, date right
>    - Font: embed `Helvetica` for body, `Helvetica-Bold` for headings
>    - Heading hierarchy: H1 = 20pt bold, H2 = 16pt bold, H3 = 13pt bold, body = 11pt
>    - Code blocks: monospace font, light gray background rectangle behind text
>    - Tables: rendered as bordered grids
>    - Consistent line spacing: 1.5× body text size
> 4. Save to outputPath
>
> Add an 'Export as PDF' button to the NotesEditor toolbar. On click: open native save dialog, call `noteExporter`."

**Debug checkpoint:**
- [ ] Export a note with headings, bullet lists, a table, and a code block
- [ ] Open resulting PDF in external PDF reader — verify layout, fonts, page numbers

---

## Phase 10 — Beta Testing & Final Integration

### Step 10.1 — End-to-End Integration Test

**Manual test script — run through this entire flow before calling the build complete:**

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
   [ ] Open PDF in external reader → verify highlights visible

3. NOTES WORKFLOW
   [ ] Create new note via '+ New Note' button
   [ ] Type markdown: # Heading, bullet list, **bold**, `code`, a table
   [ ] Live Preview renders inline while typing
   [ ] Ctrl+E → Read mode → full render
   [ ] Ctrl+E again → back to Edit mode
   [ ] Check file saved on disk (correct .md file content)
   [ ] Insert an exam template → correct markdown inserted

4. SEARCH WORKFLOW
   [ ] Ctrl+K → Spotlight → type a term from an indexed PDF → result appears
   [ ] Click result → PDF opens at correct page
   [ ] Full Search → type a concept not verbatim in docs → semantic results appear
   [ ] Annotate a page, search for annotation text → annotated page appears boosted

5. AI PANEL WORKFLOW
   [ ] All three AI tabs load (may need login on first use)
   [ ] Switching tabs preserves session
   [ ] Highlight PDF text → Send to Claude → Claude tab activates, text injected
   [ ] Select Claude response → Save to Notes → content in correct note file

6. EXPORT
   [ ] Open a note → Export as PDF → save dialog → open resulting PDF → verify format

7. KEYBOARD SHORTCUTS
   [ ] Ctrl+K, Ctrl+E, Ctrl+[, Ctrl+], Ctrl+N, Ctrl+F all work
```

---

### Step 10.2 — Error Handling Audit

**Prompt for Copilot:**
> "Audit the entire codebase for unhandled errors. Add error boundaries to these components: PDFViewer, NotesEditor, AIPanel, VaultSidebar. Each ErrorBoundary should render a minimal error card with the error message and a 'Try Again' button that resets the component state.
>
> Also add these specific error handlers:
> - `indexFile` failure: log error with file path, mark file as `indexed_at = -1` in SQLite (failed state), continue with next file
> - Webview load failure: show 'Failed to load [AI name]. Check your internet connection.' overlay with retry button
> - PDF parse failure: show 'Could not read this PDF. It may be encrypted or corrupted.' message in viewer
> - LanceDB failure: fall back to SQLite FTS5-only search, show warning toast 'Semantic search unavailable'"

---

### Step 10.3 — Build Configuration

**Prompt for Copilot:**
> "Configure `forge.config.ts` for distribution builds:
> - macOS: `.dmg` and `.zip`, code-sign if certificates available, set app icon to `assets/icon.icns`
> - Windows: `.exe` NSIS installer, set app icon to `assets/icon.ico`
> - Linux: `.AppImage`
> - All platforms: set `productName: 'Axiom'`, `appId: 'com.axiom.studyos'`
> - Configure `electron-rebuild` to rebuild native modules (better-sqlite3, vectordb) for the Electron version during packaging
> - Add a `postinstall` npm script that runs `electron-rebuild` automatically after `npm install`"

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

*This plan covers all four roadmap months from the Axiom spec. Implement phases in order — each phase builds on the last. Never start a new phase until all debug checkpoints in the current phase pass.*
