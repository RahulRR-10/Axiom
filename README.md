<div align="center">

# ⚡ Axiom

### The Study Operating System

**Your documents. Your notes. Your AI. One window. Fully offline.**

[![Electron](https://img.shields.io/badge/Electron-40-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-4.5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

</div>

---

Axiom is an AI-powered desktop app that turns any folder of PDFs, Markdown notes, and text files into a fully searchable, annotatable, AI-assisted knowledge base. No cloud. No API keys. Everything runs locally.

Point Axiom at a folder — it indexes every document with local vector embeddings, lets you annotate and take linked notes, and embeds **ChatGPT**, **Claude**, and **Gemini** directly in the app with vault-grounded responses powered by your own files.

```
┌─────────────────────────────────────────────────────────────────┐
│  Vault Sidebar  │       Multi-Tab Workspace       │  AI Panel  │
│                 │                                  │            │
│  📁 folder tree │  📄 PDF Viewer + Annotations     │  ChatGPT   │
│  📝 notes list  │  📝 Markdown Editor (CodeMirror) │  Claude    │
│  🔍 search      │  📑 Tabbed document viewing      │  Gemini    │
│  📊 index stats │  🖊️ Rich annotation toolkit      │  Sources   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Table of Contents

- [Key Features](#key-features)
- [How It Works](#how-it-works)
- [Tech Stack](#tech-stack)
- [Getting Started](#getting-started)
- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [IPC API Reference](#ipc-api-reference)
- [Database Schema](#database-schema)
- [Building & Packaging](#building--packaging)

---

## Key Features

### 🔍 Hybrid Search Engine

Axiom combines two search strategies for maximum recall and precision:

- **Semantic Search** — `all-MiniLM-L6-v2` embeddings (384-dim) run entirely offline via `@xenova/transformers`, stored in LanceDB with cosine similarity ranking
- **Full-Text Search** — SQLite FTS5 with BM25 ranking for exact keyword matching
- **Smart Merging** — Results from both engines are deduplicated and scored (40% keyword, 60% semantic), with annotation-sourced chunks boosted 1.3×
- **Multi-Pass Fallback** — Searches chunks → notes → filenames if no results found
- **Filters** — Narrow results by file type (PDF / Markdown / text) or subject (inferred from folder name)

### 📄 PDF Viewer & Annotations

A full-featured document viewer built on `pdfjs-dist`:

- **High-fidelity rendering** with device pixel ratio support and selectable text layer
- **Lazy page rendering** — only pages in the viewport (±1200px) are rendered, keeping 100+ page PDFs smooth
- **Zoom** — 50–300% with incremental controls
- **Annotation toolkit** — highlights (8 colors), sticky notes, textboxes, freehand drawing, eraser
- **Persistent annotations** — saved as JSON in SQLite, reloaded on open, and indexed for search
- **PDF export** — flatten annotations back into the source PDF with `pdf-lib`
- **Undo/redo**, drag-and-drop repositioning, resize handles, inline editing

### 📝 Markdown Notes

A professional editing environment powered by CodeMirror 6:

- **Syntax highlighting**, bracket matching, autocompletion, line numbers
- **Formatting toolbar** — bold, italic, code, headings, lists (bullet/numbered/task), tables, blockquotes, math blocks, code blocks
- **LaTeX math** — inline `$...$` and block `$$...$$` via KaTeX, with auto-conversion of `\[...\]` and `\(...\)` notation
- **Read mode** — GitHub Flavored Markdown rendering with rendered math, tables, and task lists
- **Source linking** — pin any note to a specific document and page number
- **Autosave** — 1-second debounce to SQLite with visual save indicator
- **PDF export** — render any note as a formatted, print-ready PDF

### 🤖 AI Integration

Embed ChatGPT, Claude, and Gemini directly in the app — each in an isolated, persistent webview:

- **Vault-grounded Q&A** — ask a question and Axiom retrieves the top semantic chunks from your vault, builds a grounded prompt (`"Answer ONLY using the provided material..."`), and injects it directly into the active AI chat
- **Sources panel** — see exactly which files and pages were used to ground each answer, with one-click navigation to the source
- **Persistent sessions** — login once, stay logged in across restarts via session partitions
- **Chrome-level spoofing** — Electron fingerprints stripped and replaced with real Chrome headers (UA, `sec-ch-ua`, `accept-language`) for seamless authentication
- **Auth popup handling** — Google/OpenAI/Anthropic redirects intercepted and opened in a properly spoofed popup window

### 📁 Vault Management

- **Real-time file watching** — chokidar monitors your vault for new, changed, or deleted files with 500ms debounce
- **Smart re-indexing** — SHA-256 content hash + mtime check skips unchanged files
- **Multi-format support** — PDF, Markdown, plain text (PPTX parsing compiled in but disabled)
- **Automatic chunking** — sliding window (300 tokens, 50-token overlap) preserves cross-page context
- **Live progress** — indexing progress streamed to the UI in real time

### 🖥️ App Shell

- **Three-panel layout** — collapsible vault sidebar (left), multi-tab workspace (center), drag-resizable AI panel (right, 200–700px)
- **Frameless window** — custom title bar with native minimize/maximize/close controls
- **Multi-tab workspace** — open multiple documents simultaneously with per-tab state (file, type, scroll position)
- **Keyboard shortcuts** — `Ctrl+K` opens the universal search spotlight
- **Dark mode** — dark-first design throughout

---

## How It Works

### Indexing Pipeline

```
New/Changed File Detected (chokidar)
        │
        ▼
  Hash check (SHA-256 + mtime) ── skip if unchanged
        │
        ▼
  Extract text ── pdf-parse (PDFs) · fs.readFile (text/md)
        │
        ▼
  Chunk text ── sliding window, 300 tokens, 50-token overlap
        │
        ▼
  Embed chunks ── all-MiniLM-L6-v2, batches of 32
        │
        ├──► SQLite  (files → chunks → FTS5 virtual table)
        └──► LanceDB (384-dim vector embeddings)
```

### Search Flow

```
User Query
    │
    ├──► FTS5 keyword search (BM25 ranked)
    │
    └──► Embed query → cosine similarity in LanceDB (top-k)
                │
                ▼
    Merge + deduplicate + score → ranked SearchResult[]
```

### Vault-Grounded AI Flow

```
User asks a question
        │
        ▼
  Hybrid search → top-2 semantic chunks from vault
        │
        ▼
  buildVaultPrompt(question, chunks)
  → "You are a study assistant. Answer using ONLY..."
        │
        ▼
  vaultInject → DOM automation into active AI webview
  → text injected + Enter dispatched
```

---

## Tech Stack

| Layer             | Technology                                                          |
| ----------------- | ------------------------------------------------------------------- |
| **Desktop**       | Electron 40, electron-forge 7                                       |
| **Frontend**      | React 19, TypeScript ~4.5, Tailwind CSS 3                           |
| **Build**         | Webpack 5, ts-loader, fork-ts-checker                               |
| **Database**      | better-sqlite3 (metadata + FTS5), LanceDB (vectors)                 |
| **Embeddings**    | `@xenova/transformers` — all-MiniLM-L6-v2, 384-dim, fully offline   |
| **PDF**           | pdfjs-dist (render), pdf-parse (extract), pdf-lib (export)          |
| **Markdown**      | CodeMirror 6, react-markdown, remark-gfm, remark-math, rehype-katex |
| **Math**          | KaTeX 0.16                                                          |
| **File Watching** | chokidar 4                                                          |
| **Icons**         | lucide-react                                                        |

---

## Getting Started

### Prerequisites

- **Node.js** 18+
- **Python** (required by `node-gyp` for native modules)
- C++ build toolchain:
  - **Windows:** Visual Studio Build Tools with "Desktop development with C++"
  - **macOS:** `xcode-select --install`
  - **Linux:** `build-essential`

### Install & Run

```bash
git clone https://github.com/RahulRR-10/Axiom.git
cd axiom
npm install        # postinstall rebuilds better-sqlite3 + vectordb for Electron
npm start          # launches in dev mode with hot-reload
```

### First Launch

1. Click **Open Vault** and pick a folder of study files
2. Watch the indexing progress bar as Axiom processes your documents
3. Use **Ctrl+K** to open search, or browse the vault sidebar
4. Open the **AI Panel**, log in to ChatGPT / Claude / Gemini (one-time)
5. Ask a question — Axiom grounds the AI's response with your vault content

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Electron Main Process                    │
│                                                                 │
│  ┌──────────────┐  ┌─────────────────┐  ┌───────────────────┐  │
│  │   IPC Layer  │  │    Indexer       │  │   AI Spoofing     │  │
│  │              │  │                  │  │                   │  │
│  │ vaultHandlers│  │ text extraction  │  │ session partitions│  │
│  │ searchHandler│  │ chunking         │  │ header rewriting  │  │
│  │ notesHandlers│  │ embedding        │  │ UA spoofing       │  │
│  │ annotHandlers│  │ fts5 + lancedb   │  │ auth popup proxy  │  │
│  │ ai vault inj.│  └────────┬────────┘  └───────────────────┘  │
│  └──────┬───────┘           │                                   │
│         │                   │                                   │
│  ┌──────▼───────────────────▼───────────────────────────────┐  │
│  │                  Database Layer                           │  │
│  │   better-sqlite3 (files, chunks, notes, annotations,     │  │
│  │   tags, FTS5 virtual tables, schema_migrations)           │  │
│  │                  + LanceDB (vector store)                 │  │
│  └───────────────────────────────────────────────────────────┘  │
└───────────────────────────────┬─────────────────────────────────┘
                                │ contextBridge (preload)
┌───────────────────────────────▼─────────────────────────────────┐
│                      Renderer Process                           │
│                                                                 │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                      AppLayout                             │ │
│  │  ┌─────────────┐  ┌────────────────────┐  ┌────────────┐  │ │
│  │  │ VaultSidebar│  │     Workspace      │  │  AIPanel   │  │ │
│  │  │             │  │                    │  │            │  │ │
│  │  │ folder tree │  │  WorkspaceTabBar   │  │ ChatGPT    │  │ │
│  │  │ file list   │  │  PDFViewer         │  │ Claude     │  │ │
│  │  │ create note │  │  ↳ AnnotationLayer │  │ Gemini     │  │ │
│  │  │ SearchPanel │  │  NotesEditor       │  │ (webviews) │  │ │
│  │  │             │  │  ↳ CodeMirror 6    │  │ Sources    │  │ │
│  │  └─────────────┘  └────────────────────┘  └────────────┘  │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

---

## Project Structure

```
src/
├── main/                          # Electron main process
│   ├── index.ts                   # Entry point, window creation, IPC wiring
│   ├── ai/
│   │   ├── spoofing.ts            # Session partitions, header spoofing, auth proxy
│   │   └── vaultInject.ts         # DOM injection into AI webviews
│   ├── database/
│   │   ├── schema.ts              # SQLite connection, WAL, migration runner
│   │   ├── migrations.ts          # Versioned schema migrations (001–004)
│   │   └── vectorStore.ts         # LanceDB wrapper (add/delete/query)
│   ├── indexing/
│   │   └── indexer.ts             # Text extraction, chunking, embedding pipeline
│   ├── ipc/
│   │   ├── vaultHandlers.ts       # Vault open, browse, index status
│   │   ├── searchHandlers.ts      # Hybrid FTS5 + semantic search
│   │   ├── notesHandlers.ts       # Notes CRUD + PDF export
│   │   └── annotationHandlers.ts  # Annotation save/load/delete/reindex
│   ├── vault/
│   │   └── vaultWatcher.ts        # chokidar file system watcher
│   └── workers/
│       └── embedder.ts            # all-MiniLM-L6-v2 embedding worker
│
├── preload/
│   └── index.ts                   # contextBridge — safe IPC surface
│
├── renderer/                      # React UI
│   ├── App.tsx                    # Root component
│   ├── components/
│   │   ├── ai/AIPanel.tsx         # AI webviews + sources panel
│   │   ├── layout/
│   │   │   ├── AppLayout.tsx      # Three-panel shell, drag-resize
│   │   │   └── WindowControlsToolbar.tsx
│   │   ├── search/SearchPanel.tsx # Universal search spotlight
│   │   ├── vault/VaultSidebar.tsx # File tree + vault management
│   │   └── workspace/
│   │       ├── Workspace.tsx      # Tab manager + content routing
│   │       ├── WorkspaceTabBar.tsx
│   │       ├── FloatingActionBar.tsx
│   │       ├── notes/NotesEditor.tsx   # CodeMirror 6 + read mode
│   │       └── pdf/
│   │           ├── PDFViewer.tsx       # pdfjs-dist renderer
│   │           ├── PDFToolbar.tsx      # Annotation + nav controls
│   │           └── AnnotationLayer.tsx # Canvas annotation layer
│   ├── hooks/useSearch.ts         # Debounced search hook
│   └── utils/buildVaultPrompt.ts  # Grounded prompt builder
│
└── shared/
    ├── types.ts                   # Shared TypeScript types
    └── ipc/
        ├── channels.ts            # IPC channel constants
        └── contracts.ts           # Request/response type contracts
```

---

## IPC API Reference

All renderer ↔ main communication uses a typed `electronAPI` object exposed via `contextBridge`. Channel constants are in `src/shared/ipc/channels.ts`, type contracts in `src/shared/ipc/contracts.ts`.

<details>
<summary><strong>Vault Channels</strong></summary>

| Channel                | Direction | Description                         |
| ---------------------- | --------- | ----------------------------------- |
| `vault:select`         | invoke    | Open system folder picker           |
| `vault:open`           | invoke    | Open vault, start indexer & watcher |
| `vault:readDirectory`  | invoke    | List directory as `FileNode[]`      |
| `vault:readFile`       | invoke    | Read file as `Uint8Array`           |
| `vault:writeFile`      | invoke    | Write file contents                 |
| `vault:getIndexStatus` | invoke    | Current `IndexStatus`               |
| `vault:getFileId`      | invoke    | Resolve file path → SQLite ID       |
| `vault:indexProgress`  | push      | Streaming index progress events     |
| `vault:fileChanged`    | push      | File add/change/delete events       |

</details>

<details>
<summary><strong>Search Channels</strong></summary>

| Channel        | Direction | Description                                      |
| -------------- | --------- | ------------------------------------------------ |
| `search:query` | invoke    | Hybrid FTS5 + semantic search → `SearchResult[]` |

</details>

<details>
<summary><strong>Notes Channels</strong></summary>

| Channel           | Direction | Description                      |
| ----------------- | --------- | -------------------------------- |
| `notes:create`    | invoke    | Create note → `NoteSummary`      |
| `notes:read`      | invoke    | Read note by ID → `NoteDetail`   |
| `notes:list`      | invoke    | List all notes → `NoteSummary[]` |
| `notes:update`    | invoke    | Update note content              |
| `notes:delete`    | invoke    | Delete note                      |
| `notes:move`      | invoke    | Move note to new directory       |
| `notes:rename`    | invoke    | Rename note title                |
| `notes:exportPdf` | invoke    | Render HTML → PDF                |

</details>

<details>
<summary><strong>Annotation Channels</strong></summary>

| Channel                 | Direction | Description                     |
| ----------------------- | --------- | ------------------------------- |
| `annotation:save`       | invoke    | Persist annotation → `{ id }`   |
| `annotation:load`       | invoke    | Load all annotations for a file |
| `annotation:delete`     | invoke    | Delete annotation by ID         |
| `annotation:reindexPdf` | invoke    | Re-index with annotation text   |

</details>

<details>
<summary><strong>AI Channels</strong></summary>

| Channel               | Direction | Description                            |
| --------------------- | --------- | -------------------------------------- |
| `ai:getPreloadPath`   | invoke    | Path to webview spoofing preload       |
| `ai:register-webview` | send      | Register webview under provider name   |
| `ai:vault-inject`     | invoke    | Inject grounded prompt into AI webview |

</details>

<details>
<summary><strong>Window Channels</strong></summary>

| Channel                    | Direction | Description                |
| -------------------------- | --------- | -------------------------- |
| `window:minimize`          | invoke    | Minimize window            |
| `window:toggle-maximize`   | invoke    | Toggle maximize/restore    |
| `window:close`             | invoke    | Close application          |
| `window:is-maximized`      | invoke    | Get maximized state        |
| `window:maximized-changed` | push      | Maximize/unmaximize events |

</details>

---

## Database Schema

Per-vault SQLite database at `<vault>/.axiom/axiom.db` with WAL mode, foreign keys, and versioned migrations. Vector embeddings stored separately in LanceDB at `<vault>/.axiom/vectors/`.

<details>
<summary><strong>View full schema</strong></summary>

```sql
-- Migration tracking
schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER)

-- Indexed files
files (
  id           TEXT PRIMARY KEY,  -- UUID
  path         TEXT UNIQUE NOT NULL,
  name         TEXT NOT NULL,
  type         TEXT NOT NULL,      -- 'pdf' | 'md' | 'txt' | 'pptx'
  subject      TEXT,              -- inferred from parent folder
  size         INTEGER,
  mtime_ms     INTEGER,
  content_hash TEXT,              -- SHA-256 for change detection
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

-- Tag taxonomy (schema ready, UI not yet implemented)
tags (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL)
file_tags (file_id TEXT, tag_id TEXT, PRIMARY KEY (file_id, tag_id))

-- Document annotations
annotations (
  id         TEXT PRIMARY KEY,
  file_id    TEXT NOT NULL,
  page       INTEGER NOT NULL,
  type       TEXT NOT NULL,       -- 'highlight' | 'sticky' | 'textbox' | 'draw' | 'image'
  data_json  TEXT NOT NULL,
  created_at INTEGER DEFAULT (unixepoch())
)
```

</details>

---

## Building & Packaging

```bash
npm run package    # create distributable for current platform
npm run make       # build platform installers (Squirrel/deb/rpm/zip)
```

electron-forge bundles into an ASAR archive. Native modules (`better-sqlite3`, `vectordb`) are rebuilt automatically via `postinstall`. The `all-MiniLM-L6-v2` model weights are downloaded on first launch and cached locally by transformers.js.

---

## License

[MIT](LICENSE)

---

<div align="center">

**Built with Electron, React, and local embeddings.**

[Report Bug](https://github.com/RahulRR-10/Axiom/issues) · [Request Feature](https://github.com/RahulRR-10/Axiom/issues)

</div>

### Knowledge Base & Search

- **Automatic Indexing** — Drop files into your vault and Axiom picks them up in real time with chokidar-powered file watching
- **Semantic Search** — All-MiniLM-L6-v2 embeddings (384-dim, fully local via `@xenova/transformers`) stored in LanceDB
- **Full-Text Search** — Parallel FTS5 (SQLite) keyword search for exact-match and fast recall
- **Hybrid Results** — Semantic and keyword results merged into ranked, categorised results
- **Supported Formats** — PDF, PPTX, Markdown, plain text

### Document Viewer

- **PDF Rendering** — High-fidelity rendering with `pdfjs-dist`, page navigation, and zoom
- **Annotation Toolkit** — Highlight, sticky notes, freehand drawing, textboxes, image embeds, eraser
- **Annotation Persistence** — Annotations saved to SQLite as JSON and reloaded on next open; indexed alongside document chunks for search
- **PDF Export** — Write annotations back into the source PDF with `pdf-lib`

### Notes

- **Markdown Editor** — CodeMirror 6 editor with syntax highlighting and autocomplete
- **LaTeX Support** — Inline and block math via KaTeX and remark-math/rehype-katex
- **Source Linking** — Notes can be pinned to a source file and page number
- **PDF Export** — Export any note as a formatted PDF

### AI Integration

- **Three Providers** — ChatGPT, Claude, Gemini — each in a persistent, isolated webview partition
- **Session Persistence** — Login state is retained across app restarts
- **Header Spoofing** — Electron fingerprints are stripped and replaced with real Chrome headers so Google/Anthropic authentication works without interruption

### App Shell

- **Frameless Window** — Custom title bar with native window controls (minimize, maximize, close)
- **Collapsible Panels** — Vault sidebar and AI panel can be hidden to maximize workspace
- **Multi-Tab Workspace** — Open multiple documents simultaneously with per-tab state
- **Real-Time Progress** — Indexing progress events pushed to the renderer during initial vault scan

---

## Tech Stack

| Layer              | Technology                                                          |
| ------------------ | ------------------------------------------------------------------- |
| **Desktop Shell**  | Electron 40                                                         |
| **UI Framework**   | React 19, TypeScript ~4.5                                           |
| **Styling**        | Tailwind CSS 3, PostCSS, dark-mode-first                            |
| **Build**          | electron-forge 7, Webpack 5, ts-loader                              |
| **Database**       | better-sqlite3 (metadata, FTS5), LanceDB / vectordb (vectors)       |
| **Embeddings**     | `@xenova/transformers` — all-MiniLM-L6-v2, 384-dim, fully offline   |
| **PDF Rendering**  | pdfjs-dist 5                                                        |
| **PDF Processing** | pdf-parse (extraction), pdf-lib (annotation export)                 |
| **Office Parsing** | officeparser (PPTX)                                                 |
| **Markdown**       | CodeMirror 6, react-markdown, remark-gfm, remark-math, rehype-katex |
| **Math**           | KaTeX 0.16                                                          |
| **Icons**          | lucide-react                                                        |
| **File Watching**  | chokidar 4                                                          |
| **Config Storage** | electron-store 11                                                   |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Electron Main Process                    │
│                                                                 │
│  ┌──────────────┐  ┌─────────────────┐  ┌───────────────────┐  │
│  │   IPC Layer  │  │    Indexer       │  │   AI Spoofing     │  │
│  │              │  │                 │  │                   │  │
│  │ vaultHandlers│  │ text extraction │  │ session partitions│  │
│  │ searchHandler│  │ chunking        │  │ header rewriting  │  │
│  │ notesHandlers│  │ embedding       │  │ UA spoofing       │  │
│  │ annotHandlers│  │ fts5 + lancedb  │  │ OAuth popups      │  │
│  └──────┬───────┘  └────────┬────────┘  └───────────────────┘  │
│         │                  │                                    │
│  ┌──────▼──────────────────▼────────────────────────────────┐  │
│  │                  Database Layer                           │  │
│  │   better-sqlite3 (files, chunks, notes, annotations,     │  │
│  │   FTS5 virtual tables)   +   LanceDB (vector store)      │  │
│  └───────────────────────────────────────────────────────────┘  │
└───────────────────────────────┬─────────────────────────────────┘
                                │ contextBridge (preload)
┌───────────────────────────────▼─────────────────────────────────┐
│                      Renderer Process                           │
│                                                                 │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                      AppLayout                             │ │
│  │  ┌─────────────┐  ┌────────────────────┐  ┌────────────┐  │ │
│  │  │ VaultSidebar│  │     Workspace       │  │  AIPanel   │  │ │
│  │  │             │  │                    │  │            │  │ │
│  │  │ folder tree │  │  WorkspaceTabBar    │  │ ChatGPT    │  │ │
│  │  │ file list   │  │                    │  │ Claude     │  │ │
│  │  │ create note │  │  PDFViewer         │  │ Gemini     │  │ │
│  │  │             │  │  ↳ PDFToolbar      │  │ (webviews) │  │ │
│  │  │  SearchPanel│  │  ↳ AnnotationLayer │  │            │  │ │
│  │  │             │  │                    │  │            │  │ │
│  │  │             │  │  NotesEditor       │  │            │  │ │
│  │  │             │  │  ↳ CodeMirror 6    │  │            │  │ │
│  │  └─────────────┘  └────────────────────┘  └────────────┘  │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### Data Flow — Indexing

```
New/Changed File Detected (chokidar)
        │
        ▼
  Extract Text
  (pdf-parse / officeparser / fs.readFile)
        │
        ▼
  Chunk Text (sliding window)
        │
        ▼
  Embed Chunks
  (@xenova/transformers, batch of 32)
        │
        ├──► SQLite  (files, chunks, FTS5 virtual table)
        └──► LanceDB (vector embeddings)
```

### Data Flow — Search

```
User Query
    │
    ├──► FTS5 keyword search on chunks table
    │        (ranked by BM25)
    │
    └──► Embed query → cosine similarity in LanceDB
             (top-k semantic results)

Both result sets merged → deduplicated → returned to renderer
```

---

## Getting Started

### Prerequisites

- **Node.js** 18 or later
- **Python** (required by `node-gyp` for native module compilation)
- A C++ build toolchain
  - Windows: Visual Studio Build Tools with "Desktop development with C++"
  - macOS: Xcode Command Line Tools (`xcode-select --install`)
  - Linux: `build-essential`

### Install

```bash
git clone https://github.com/your-org/axiom.git
cd axiom
npm install
```

`postinstall` runs `electron-rebuild` automatically to compile `better-sqlite3` and `vectordb` against the correct Electron ABI.

### Run (Development)

```bash
npm start
```

Starts electron-forge in development mode with hot-reload for the renderer process.

### First Launch

1. Click **Open Vault** and select a folder containing your study files
2. Axiom will begin indexing — a progress bar appears and updates in real time
3. Once indexing completes, use the **Search** panel or browse the **Vault Sidebar** to open files
4. Open the **AI Panel** on the right and log in to ChatGPT, Claude, or Gemini once; sessions persist across restarts

---

## Project Structure

```
axiom/
├── src/
│   ├── main/                     # Electron main process
│   │   ├── index.ts              # Entry point, window creation, IPC registration
│   │   ├── ai/
│   │   │   └── spoofing.ts       # Webview session & header spoofing
│   │   ├── database/
│   │   │   ├── schema.ts         # SQLite connection & schema bootstrap
│   │   │   ├── migrations.ts     # Versioned migrations (001–003)
│   │   │   └── vectorStore.ts    # LanceDB wrapper
│   │   ├── indexing/
│   │   │   └── indexer.ts        # File parsing, chunking, embedding pipeline
│   │   ├── ipc/
│   │   │   ├── vaultHandlers.ts  # Vault open / browse / index-status
│   │   │   ├── searchHandlers.ts # Hybrid FTS5 + semantic query
│   │   │   ├── notesHandlers.ts  # Notes CRUD + PDF export
│   │   │   └── annotationHandlers.ts  # Annotation save/load/reindex
│   │   ├── vault/
│   │   │   └── vaultWatcher.ts   # chokidar real-time watcher
│   │   └── workers/
│   │       └── embedder.ts       # all-MiniLM-L6-v2 embedding worker
│   │
│   ├── preload/
│   │   └── index.ts              # contextBridge — exposes electronAPI to renderer
│   │
│   ├── renderer/                 # React renderer
│   │   ├── App.tsx
│   │   ├── index.tsx
│   │   ├── styles.css
│   │   ├── components/
│   │   │   ├── ai/
│   │   │   │   └── AIPanel.tsx         # ChatGPT / Claude / Gemini webviews
│   │   │   ├── layout/
│   │   │   │   ├── AppLayout.tsx       # Three-panel shell
│   │   │   │   └── WindowControlsToolbar.tsx
│   │   │   ├── search/
│   │   │   │   └── SearchPanel.tsx
│   │   │   ├── vault/
│   │   │   │   └── VaultSidebar.tsx    # File tree + vault switcher
│   │   │   └── workspace/
│   │   │       ├── Workspace.tsx       # Tab manager
│   │   │       ├── WorkspaceTabBar.tsx
│   │   │       ├── FloatingActionBar.tsx
│   │   │       ├── notes/
│   │   │       │   └── NotesEditor.tsx # CodeMirror 6 editor
│   │   │       └── pdf/
│   │   │           ├── PDFViewer.tsx   # pdfjs-dist renderer
│   │   │           ├── PDFToolbar.tsx  # Annotation + navigation controls
│   │   │           └── AnnotationLayer.tsx
│   │   └── hooks/
│   │       └── useSearch.ts
│   │
│   └── shared/
│       ├── types.ts              # Shared TypeScript types
│       └── ipc/
│           ├── channels.ts       # IPC channel name constants
│           └── contracts.ts      # Request/response type contracts
│
├── forge.config.ts               # electron-forge config (ASAR, fuses, makers)
├── webpack.main.config.ts
├── webpack.renderer.config.ts
├── webpack.plugins.ts
├── webpack.rules.ts
├── tailwind.config.ts
├── postcss.config.js
└── tsconfig.json
```

---

## IPC API

All renderer↔main communication is funnelled through a typed `electronAPI` object exposed via the preload `contextBridge`. Channel names and request/response shapes live in `src/shared/ipc/`.

### Vault Channels

| Channel                  | Direction | Description                                      |
| ------------------------ | --------- | ------------------------------------------------ |
| `vault:select`           | invoke    | Open system folder picker, returns selected path |
| `vault:open`             | invoke    | Open vault at path, starts indexer & watcher     |
| `vault:read-directory`   | invoke    | List directory contents as `FileNode[]`          |
| `vault:read-file`        | invoke    | Read raw file contents                           |
| `vault:write-file`       | invoke    | Write raw file contents                          |
| `vault:get-index-status` | invoke    | Returns `IndexStatus` for the open vault         |
| `vault:get-file-id`      | invoke    | Resolve file path → SQLite file ID               |
| `vault:index-progress`   | push      | Streaming progress events during indexing        |
| `vault:file-changed`     | push      | Emitted when a watched file changes              |

### Search Channels

| Channel        | Direction | Description                                                 |
| -------------- | --------- | ----------------------------------------------------------- |
| `search:query` | invoke    | Run hybrid FTS5 + semantic search, returns `SearchResult[]` |

### Notes Channels

| Channel            | Direction | Description                   |
| ------------------ | --------- | ----------------------------- |
| `notes:create`     | invoke    | Create a new note             |
| `notes:read`       | invoke    | Read note content by ID       |
| `notes:list`       | invoke    | List all notes (summarised)   |
| `notes:update`     | invoke    | Update note title/content     |
| `notes:delete`     | invoke    | Delete note by ID             |
| `notes:move`       | invoke    | Move note to a new vault path |
| `notes:rename`     | invoke    | Rename note file              |
| `notes:export-pdf` | invoke    | Export note Markdown → PDF    |

### Annotation Channels

| Channel                   | Direction | Description                                    |
| ------------------------- | --------- | ---------------------------------------------- |
| `annotations:save`        | invoke    | Persist annotation set for a PDF page          |
| `annotations:load`        | invoke    | Load all annotations for a file                |
| `annotations:delete`      | invoke    | Delete a single annotation by ID               |
| `annotations:reindex-pdf` | invoke    | Re-run indexing pass including annotation text |

### Window Channels

| Channel                  | Direction | Description              |
| ------------------------ | --------- | ------------------------ |
| `window:minimize`        | send      | Minimize the main window |
| `window:toggle-maximize` | send      | Toggle maximize/restore  |
| `window:close`           | send      | Close the application    |

---

## Database Schema

SQLite database is stored per-vault under `<vault>/.axiom/axiom.db`.

```sql
-- Indexed files
files (
  id           TEXT PRIMARY KEY,   -- UUID
  path         TEXT UNIQUE,
  name         TEXT,
  type         TEXT,               -- 'pdf' | 'pptx' | 'md' | 'txt'
  subject      TEXT,
  size         INTEGER,
  mtime_ms     INTEGER,
  content_hash TEXT,
  indexed_at   INTEGER
)

-- Text chunks (source for FTS and embeddings)
chunks (
  id            TEXT PRIMARY KEY,
  file_id       TEXT REFERENCES files(id),
  page_or_slide INTEGER,
  text          TEXT,
  chunk_index   INTEGER,
  is_annotation INTEGER DEFAULT 0
)

-- FTS5 virtual table (mirrors chunks)
chunks_fts (text, content='chunks', content_rowid='rowid')

-- Markdown notes
notes (
  id             TEXT PRIMARY KEY,
  title          TEXT,
  content        TEXT,
  subject        TEXT,
  source_file_id TEXT,
  source_page    INTEGER,
  created_at     INTEGER,
  updated_at     INTEGER
)

-- PDF / PPTX annotations
annotations (
  id         TEXT PRIMARY KEY,
  file_id    TEXT,
  page       INTEGER,
  type       TEXT,               -- 'highlight' | 'sticky' | 'textbox' | 'draw' | 'image'
  data_json  TEXT,
  created_at INTEGER
)
```

---

## Building & Packaging

### Development Build

```bash
npm start        # dev mode with hot reload
```

### Production Package

```bash
npm run package  # bundles app without installer
npm run make     # creates platform-specific installer
```

**Outputs:**

- Windows: Squirrel installer (`.exe`)
- macOS: ZIP archive
- Linux: RPM and DEB packages

### Key Build Details

- **ASAR**: App source is bundled into an ASAR archive
- **Native Modules**: `better-sqlite3` and `vectordb` are excluded from webpack bundling and loaded at runtime; `electron-rebuild` ensures they match the target Electron ABI
- **Electron Fuses** (applied at package time):
  - Cookie encryption enabled
  - Node.js CLI inspect / REPL disabled in production
  - ASAR integrity checking enabled

---

<div align="center">
Built with Electron, React, and a lot of local embeddings.
</div>
