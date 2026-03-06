<div align="center">

# Axiom

**AI-Powered Study Operating System**

An Electron desktop application that turns your study vault into a fully searchable, annotatable, AI-assisted knowledge base — entirely offline embeddings, no API keys required.

</div>

---

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Architecture](#architecture)
- [Getting Started](#getting-started)
- [Project Structure](#project-structure)
- [IPC API](#ipc-api)
- [Database Schema](#database-schema)
- [Building & Packaging](#building--packaging)

---

## Overview

Axiom is a desktop application built on **Electron + React** that creates a personal, offline-first study environment. Point it at a folder of PDFs, PowerPoints, Markdown notes, or text files and Axiom will:

- Index every document with local vector embeddings (no cloud, no API keys)
- Expose a hybrid full-text + semantic search across all content
- Let you annotate, highlight, and take linked notes directly on documents
- Embed live sessions of **ChatGPT**, **Claude**, and **Gemini** inside the app — with persistent login

The entire workflow lives in one window: vault browser on the left, multi-tab document viewer in the center, AI chat panels on the right.

---

## Features

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
