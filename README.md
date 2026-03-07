<div align="center">

<img src="assets/axiom-logo.png" alt="Axiom Logo" width="120" />

# Axiom — The Study Operating System

**A local-first desktop environment that turns your folder of PDFs and notes into a fully searchable, annotatable, AI-assisted knowledge base.**

[![Electron](https://img.shields.io/badge/Electron-40-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-4.5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-22c55e.svg)](LICENSE)

[Getting Started](#getting-started) · [Features](#features) · [Architecture](#architecture) · [IPC API](#ipc-api) · [Database Schema](#database-schema)

</div>

---

Point Axiom at any folder of PDFs, Markdown notes, and text files. It indexes every document with **local vector embeddings**, lets you annotate freely, write linked notes, and puts **ChatGPT, Gemini, and Claude** directly in the same window — all without your files ever leaving your machine.

The AI integration is more than a browser tab. Axiom pulls the most relevant excerpts from your vault and injects them as context into whichever AI you're talking to, so answers are grounded in your actual study material rather than the model's general knowledge.

```
┌──────────────────┬──────────────────────────────┬───────────────┐
│  Vault Sidebar   │         Workspace             │   AI Panel    │
│                  │                               │               │
│  📁 Folder tree  │  📄 PDF Viewer + Annotations  │  ChatGPT      │
│  📝 Notes list   │  📝 Markdown Editor           │  Gemini       │
│  🔍 Search       │  📑 Multi-tab viewing         │  Claude       │
│                  │                               │               │
│                  │                               │  ✦ Ask your   │
│                  │                               │    vault      │
└──────────────────┴──────────────────────────────┴───────────────┘
```

---

## Table of Contents

- [Features](#features)
- [Tech Stack](#tech-stack)
- [Architecture](#architecture)
- [Getting Started](#getting-started)
- [Project Structure](#project-structure)
- [IPC API](#ipc-api)
- [Database Schema](#database-schema)
- [Building & Packaging](#building--packaging)

---

## Features

### 🔍 Knowledge Base & Search

- **Automatic Indexing** — Drop files into your vault and Axiom indexes them instantly via `chokidar` file watching with SHA-256 change detection to skip unchanged files
- **Semantic Search** — `all-MiniLM-L6-v2` embeddings (384-dim) via `@xenova/transformers`, stored in LanceDB with cosine similarity ranking
- **Full-Text Search** — Parallel FTS5 (SQLite) with BM25 ranking for exact keyword matching
- **Hybrid Results** — Both result sets merged, deduplicated, and re-scored (40% keyword + 60% semantic); annotation-sourced chunks boosted 1.3×
- **Supported Formats** — PDF, Markdown, plain text

### 📄 Document Viewer

- **PDF Rendering** — High-fidelity rendering via `pdfjs-dist` with lazy page loading, device pixel ratio support, and a fully selectable text layer
- **Zoom** — 50–300% with incremental controls
- **Annotation Toolkit** — Highlights (8 colors), sticky notes, textboxes, freehand drawing, eraser, undo/redo, drag repositioning, resize handles
- **Annotation Persistence** — Stored as JSON in SQLite, reloaded on open, and indexed alongside document chunks so they appear in search results
- **PDF Export** — Flatten annotations directly back into the source PDF with `pdf-lib`

### 📝 Notes

- **Markdown Editor** — CodeMirror 6 with syntax highlighting, bracket matching, autocompletion, and line numbers
- **Formatting Toolbar** — Bold, italic, code, headings, bullet/numbered/task lists, tables, blockquotes, math blocks, and code blocks — all one click
- **LaTeX Support** — Inline `$...$` and block `$$...$$` math via KaTeX, with automatic `\[...\]` conversion
- **Read Mode** — Full GFM rendering with math, tables, and task list checkboxes
- **Source Linking** — Pin any note to a specific document and page number for full traceability
- **Autosave** — 1-second debounce with a visual save indicator so you never lose work
- **PDF Export** — Render any note as a formatted, print-ready PDF

### 🤖 AI Integration

Axiom embeds **ChatGPT**, **Gemini**, and **Claude** directly — each running in a persistent, isolated webview partition with sessions retained across restarts. You use them exactly as you would in a browser, without ever leaving your study environment.

On top of that, Axiom adds **vault-grounded Q&A**:

| Step | What happens |
|---|---|
| You type a question | Axiom runs hybrid search over your vault |
| Top 5 chunks retrieved | Scored and trimmed to a ~1,200 token budget |
| Grounded prompt built | `"Answer ONLY using the provided study material..."` |
| Injected into active AI tab | Via `executeJavaScript` — the chat area is never resized |
| Sources panel renders | Each source is clickable, opening the exact page in the workspace |

Every source has a **▶ expand toggle** so you can read the raw chunk inline without disrupting the chat view. Two modes, one panel: freeform chat with any AI, or vault-grounded answers pulled from your actual notes and PDFs.

> **Spoofing & Auth** — Electron fingerprints are stripped and replaced with real Chrome headers (`User-Agent`, `sec-ch-ua`, `accept-language`) so authentication with Google, Anthropic, and OpenAI works without interruption. Auth popups are intercepted and opened in correctly spoofed windows.

### 🖥️ App Shell

- **Three-panel layout** — Collapsible vault sidebar (left), multi-tab workspace (center), drag-resizable AI panel (right, 200–700px)
- **Frameless window** — Custom title bar with native minimize/maximize/close controls
- **Multi-tab workspace** — Open multiple documents simultaneously with per-tab scroll and state preservation
- **Multi-window** — Pop any document into its own Electron window; annotation and note saves broadcast to all open windows in real time
- **File management** — Right-click context menu: duplicate, move (drag-to-folder picker), rename, delete to system Trash, create folder
- **Keyboard shortcuts** — `Ctrl+K` opens the universal search spotlight
- **Dark-first design** throughout

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Desktop** | Electron 40, electron-forge 7 |
| **Frontend** | React 19, TypeScript ~4.5, Tailwind CSS 3 |
| **Build** | Webpack 5, ts-loader, fork-ts-checker |
| **Database** | better-sqlite3 (metadata + FTS5), LanceDB (vectors) |
| **Embeddings** | `@xenova/transformers` — all-MiniLM-L6-v2, 384-dim |
| **PDF** | pdfjs-dist (render), pdf-parse (extract), pdf-lib (export) |
| **Markdown** | CodeMirror 6, react-markdown, remark-gfm, remark-math, rehype-katex |
| **Math** | KaTeX 0.16 |
| **File Watching** | chokidar 4 |
| **Icons** | lucide-react |
| **Config** | electron-store 11 |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Electron Main Process                    │
│                                                                 │
│  ┌──────────────┐  ┌─────────────────┐  ┌───────────────────┐  │
│  │   IPC Layer  │  │    Indexer      │  │   AI Spoofing     │  │
│  │              │  │                 │  │                   │  │
│  │ vaultHandlers│  │ text extraction │  │ session partitions│  │
│  │ searchHandler│  │ chunking        │  │ header rewriting  │  │
│  │ notesHandlers│  │ embedding       │  │ UA spoofing       │  │
│  │ annotHandlers│  │ fts5 + lancedb  │  │ auth popup proxy  │  │
│  │ ai:vault-inj │  └────────┬────────┘  └───────────────────┘  │
│  └──────┬───────┘           │                                   │
│         │                   │                                   │
│  ┌──────▼───────────────────▼───────────────────────────────┐  │
│  │                    Database Layer                         │  │
│  │   better-sqlite3 (files, chunks, notes, annotations,     │  │
│  │   FTS5 virtual tables, schema_migrations)                 │  │
│  │                 + LanceDB (vector store)                  │  │
│  └───────────────────────────────────────────────────────────┘  │
└───────────────────────────────┬─────────────────────────────────┘
                                │ contextBridge (preload)
┌───────────────────────────────▼─────────────────────────────────┐
│                        Renderer Process                         │
│                                                                 │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                        AppLayout                           │ │
│  │  ┌─────────────┐  ┌──────────────────────┐  ┌──────────┐  │ │
│  │  │ VaultSidebar│  │      Workspace        │  │ AIPanel  │  │ │
│  │  │             │  │                       │  │          │  │ │
│  │  │ folder tree │  │  WorkspaceTabBar       │  │ ChatGPT  │  │ │
│  │  │ file list   │  │  PDFViewer            │  │ Gemini   │  │ │
│  │  │ create note │  │  ↳ AnnotationLayer    │  │ Claude   │  │ │
│  │  │ SearchPanel │  │  NotesEditor          │  │ webviews │  │ │
│  │  │             │  │  ↳ CodeMirror 6       │  │          │  │ │
│  │  │             │  │                       │  │ ✦ Vault  │  │ │
│  │  └─────────────┘  └──────────────────────┘  │   Ask    │  │ │
│  │                                              └──────────┘  │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### Indexing Pipeline

```
New/Changed File (chokidar)
        │
        ▼
Hash check (SHA-256 + mtime) ── unchanged? skip.
        │
        ▼
Extract text (pdf-parse / fs.readFile)
        │
        ▼
Chunk text (sliding window — 300 tokens, 50-token overlap)
        │
        ▼
Embed chunks (@xenova/transformers, batches of 32)
        │
        ├──► SQLite  (files → chunks → FTS5 virtual table)
        └──► LanceDB (384-dim vectors)
```

### Search Flow

```
User Query
    │
    ├──► FTS5 keyword search          (BM25 ranked)
    │
    └──► Embed query → LanceDB        (cosine similarity, top-k)
                │
                ▼
    Merge + deduplicate + score → SearchResult[]
    (40% keyword weight · 60% semantic weight · 1.3× annotation boost)
```

### Vault-Grounded AI Flow

```
User submits question via vault search bar
        │
        ▼
Hybrid search → top 5 chunks (token budget: ~1,200 tokens)
        │
        ▼
buildVaultPrompt(question, chunks)
        │
        ▼
ai:vault-inject IPC → executeJavaScript into active webview
→ text set + input event + Enter dispatched
        │
        ▼
AI responds in webview · Sources panel renders with expand toggles
```

---

## Getting Started

### Prerequisites

- **Node.js** 18+
- **Python** (required by `node-gyp` for native module compilation)
- C++ build toolchain:
  - **Windows** — Visual Studio Build Tools with "Desktop development with C++"
  - **macOS** — `xcode-select --install`
  - **Linux** — `build-essential`

### Install & Run

```bash
git clone https://github.com/RahulRR-10/Axiom.git
cd axiom
npm install        # postinstall rebuilds native modules for Electron
npm start          # dev mode with hot-reload
```

### First Launch

1. Click **Open Vault** and select a folder of study files
2. Axiom indexes your documents — a real-time progress bar shows status
3. Press `Ctrl+K` to search, or browse the vault sidebar
4. Open the **AI Panel** and sign in to ChatGPT, Gemini, or Claude *(one-time — sessions persist across restarts)*
5. Use the AI tabs for freeform chat, or click **✦** to ask a question grounded in your vault

---

## Project Structure

```
src/
├── main/
│   ├── index.ts                      # Entry point, window creation, IPC wiring
│   ├── ai/
│   │   ├── spoofing.ts               # Session partitions, header spoofing, auth proxy
│   │   └── vaultInject.ts            # DOM injection into AI webviews
│   ├── database/
│   │   ├── schema.ts                 # SQLite connection, WAL mode, migration runner
│   │   ├── migrations.ts             # Versioned schema migrations (001–004)
│   │   └── vectorStore.ts            # LanceDB wrapper (add / delete / query)
│   ├── indexing/
│   │   └── indexer.ts                # Text extraction, chunking, embedding pipeline
│   ├── ipc/
│   │   ├── vaultHandlers.ts
│   │   ├── searchHandlers.ts
│   │   ├── notesHandlers.ts
│   │   └── annotationHandlers.ts
│   ├── vault/
│   │   └── vaultWatcher.ts           # chokidar watcher
│   └── workers/
│       └── embedder.ts               # Embedding worker
│
├── preload/
│   └── index.ts                      # contextBridge — safe IPC surface
│
├── renderer/
│   ├── App.tsx
│   ├── components/
│   │   ├── ai/
│   │   │   └── AIPanel.tsx           # Webviews + vault ask overlay + sources panel
│   │   ├── layout/
│   │   │   ├── AppLayout.tsx
│   │   │   └── WindowControlsToolbar.tsx
│   │   ├── search/
│   │   │   └── SearchPanel.tsx
│   │   ├── vault/
│   │   │   └── VaultSidebar.tsx
│   │   └── workspace/
│   │       ├── Workspace.tsx
│   │       ├── WorkspaceTabBar.tsx
│   │       ├── FloatingActionBar.tsx
│   │       ├── notes/
│   │       │   └── NotesEditor.tsx
│   │       └── pdf/
│   │           ├── PDFViewer.tsx
│   │           ├── PDFToolbar.tsx
│   │           └── AnnotationLayer.tsx
│   ├── hooks/
│   │   └── useSearch.ts
│   └── utils/
│       └── buildVaultPrompt.ts       # Prompt construction + token budget trimming
│
└── shared/
    ├── types.ts
    └── ipc/
        ├── channels.ts               # Channel name constants
        └── contracts.ts              # Request/response type contracts
```

---

## IPC API

All renderer ↔ main communication is funnelled through a typed `electronAPI` object exposed via `contextBridge`. Channel constants live in `src/shared/ipc/channels.ts`; request/response types in `src/shared/ipc/contracts.ts`.

### Vault Channels

| Channel | Direction | Description |
|---|---|---|
| `vault:select` | invoke | Open system folder picker |
| `vault:open` | invoke | Open vault, start indexer & watcher |
| `vault:readDirectory` | invoke | List directory as `FileNode[]` |
| `vault:readFile` | invoke | Read file as `Uint8Array` |
| `vault:writeFile` | invoke | Write file contents |
| `vault:getIndexStatus` | invoke | Current `IndexStatus` |
| `vault:getFileId` | invoke | Resolve file path → SQLite row ID |
| `vault:indexProgress` | push | Streaming index progress events |
| `vault:fileChanged` | push | File add / change / delete events |

### Search Channels

| Channel | Direction | Description |
|---|---|---|
| `search:query` | invoke | Hybrid FTS5 + semantic search → `SearchResult[]` |

### Notes Channels

| Channel | Direction | Description |
|---|---|---|
| `notes:create` | invoke | Create note → `NoteSummary` |
| `notes:read` | invoke | Read note by ID → `NoteDetail` |
| `notes:list` | invoke | List all notes → `NoteSummary[]` |
| `notes:update` | invoke | Update note content |
| `notes:delete` | invoke | Delete note |
| `notes:move` | invoke | Move note to new directory |
| `notes:rename` | invoke | Rename note title |
| `notes:exportPdf` | invoke | Render note as PDF |

### Annotation Channels

| Channel | Direction | Description |
|---|---|---|
| `annotation:save` | invoke | Persist annotation → `{ id }` |
| `annotation:load` | invoke | Load all annotations for a file |
| `annotation:delete` | invoke | Delete annotation by ID |
| `annotation:reindexPdf` | invoke | Re-index PDF with annotation text included |

### AI Channels

| Channel | Direction | Description |
|---|---|---|
| `ai:getPreloadPath` | invoke | Path to the webview spoofing preload script |
| `ai:register-webview` | send | Register a webview under its provider name |
| `ai:vault-inject` | invoke | Build + inject grounded prompt into the active AI webview |

### Window Channels

| Channel | Direction | Description |
|---|---|---|
| `window:minimize` | invoke | Minimize window |
| `window:toggle-maximize` | invoke | Toggle maximize / restore |
| `window:close` | invoke | Close the application |
| `window:is-maximized` | invoke | Get current maximized state |
| `window:maximized-changed` | push | Emitted on maximize / unmaximize |
| `window:openNew` | invoke | Open a file in a separate Electron window |

### File Channels

| Channel | Direction | Description |
|---|---|---|
| `file:makeCopy` | invoke | Duplicate file (auto-numbered name) → new path |
| `file:move` | invoke | Move file to target directory → new path; broadcasts `file:pathChanged` |
| `file:rename` | invoke | Rename file in-place → new path; broadcasts `file:pathChanged` |
| `file:delete` | invoke | Send file to system Trash |
| `file:createFolder` | invoke | Create directory (recursive) |
| `file:saveImage` | invoke | Write image buffer to disk → saved path |
| `file:selectFolder` | invoke | Open folder-picker dialog → selected path or `null` |
| `file:pathChanged` | push | Broadcast after move / rename (old + new path) |
| `pdf:fileChanged` | push | Broadcast when an open PDF is modified on disk |

### Shell Channels

| Channel | Direction | Description |
|---|---|---|
| `shell:openExternal` | invoke | Open URL or path in the OS default application |
| `shell:showItemInFolder` | invoke | Reveal file in the system file explorer |

### Broadcast Events

| Channel | Direction | Description |
|---|---|---|
| `annotations:broadcastSaved` | send | Notify all windows that annotations were saved for a file |
| `annotations:saved` | push | Received when another window saves annotations |
| `notes:broadcastSaved` | send | Notify all windows that a note was saved |
| `notes:saved` | push | Received when another window saves a note |

---

## Database Schema

Each vault stores its own SQLite database at `<vault>/.axiom/axiom.db` (WAL mode, foreign keys enabled, versioned migrations). Vector embeddings live separately in LanceDB at `<vault>/.axiom/vectors/`.

```sql
-- Migration tracking
schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER)

-- Indexed files
files (
  id           TEXT PRIMARY KEY,   -- UUID
  path         TEXT UNIQUE NOT NULL,
  name         TEXT NOT NULL,
  type         TEXT NOT NULL,       -- 'pdf' | 'md' | 'txt'
  subject      TEXT,               -- inferred from parent folder name
  size         INTEGER,
  mtime_ms     INTEGER,
  content_hash TEXT,               -- SHA-256 for change detection
  indexed_at   INTEGER,
  created_at   INTEGER DEFAULT (unixepoch())
)

-- Text chunks (source for FTS & embeddings)
chunks (
  id            TEXT PRIMARY KEY,
  file_id       TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  page_or_slide INTEGER,
  text          TEXT NOT NULL,
  chunk_index   INTEGER,
  is_annotation INTEGER DEFAULT 0
)

-- FTS5 virtual table (mirrors chunks)
chunks_fts (text, file_id, page_or_slide)

-- Markdown notes
notes (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  content        TEXT DEFAULT '',
  subject        TEXT,
  source_file_id TEXT,
  source_page    INTEGER,
  file_path      TEXT,
  created_at     INTEGER DEFAULT (unixepoch()),
  updated_at     INTEGER DEFAULT (unixepoch())
)

-- Tag taxonomy
tags       (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL)
file_tags  (file_id TEXT, tag_id TEXT, PRIMARY KEY (file_id, tag_id))

-- Document annotations
annotations (
  id         TEXT PRIMARY KEY,
  file_id    TEXT NOT NULL,
  page       INTEGER NOT NULL,
  type       TEXT NOT NULL,        -- 'highlight' | 'sticky' | 'textbox' | 'draw' | 'image'
  data_json  TEXT NOT NULL,
  created_at INTEGER DEFAULT (unixepoch())
)
```

---

## Building & Packaging

```bash
npm start          # dev mode with hot-reload
npm run package    # distributable for the current platform (no installer)
npm run make       # platform-specific installers
```

| Platform | Output |
|---|---|
| Windows | Squirrel installer (`.exe`) |
| macOS | ZIP archive |
| Linux | RPM and DEB packages |

**Build notes:**
- App source is bundled into an ASAR archive
- `better-sqlite3` and `vectordb` are excluded from webpack and loaded at runtime; `electron-rebuild` in `postinstall` ensures the correct Electron ABI
- Electron Fuses applied at package time: cookie encryption enabled, Node.js CLI inspect disabled, ASAR integrity checking enabled
- `all-MiniLM-L6-v2` model weights are downloaded on first launch and cached locally by `transformers.js` — no internet connection required after that

---

## License

[MIT](LICENSE)

---

<div align="center">
Built with Electron, React, and a lot of local embeddings.
</div>
