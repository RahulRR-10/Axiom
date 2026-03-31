import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';

import { EditorState, StateField, type Range } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, rectangularSelection, scrollPastEnd, Decoration, WidgetType, type DecorationSet } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from '@codemirror/language';
import { autocompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { oneDark } from '@codemirror/theme-one-dark';

import 'katex/dist/katex.min.css';
import './NotesEditor.css';

// ── Types ─────────────────────────────────────────────────────────────────────

type ViewMode = 'write' | 'read';

type NotesEditorProps = {
    filePath: string;
    noteId: string;
    vaultPath: string;
};

// ── Toolbar button definitions ────────────────────────────────────────────────

type ToolbarAction = {
    label: string;
    icon: string;
    title: string;
    insert: (sel: string) => { text: string; cursorOffset?: number };
};

const TOOLBAR_ACTIONS: ToolbarAction[] = [
    {
        label: 'bold', icon: 'B', title: 'Bold (Ctrl+B)',
        insert: (sel) => ({ text: `**${sel || 'bold text'}**`, cursorOffset: sel ? undefined : -2 }),
    },
    {
        label: 'italic', icon: 'I', title: 'Italic (Ctrl+I)',
        insert: (sel) => ({ text: `*${sel || 'italic text'}*`, cursorOffset: sel ? undefined : -1 }),
    },
    {
        label: 'code', icon: '<>', title: 'Inline Code',
        insert: (sel) => ({ text: `\`${sel || 'code'}\``, cursorOffset: sel ? undefined : -1 }),
    },
    {
        label: 'link', icon: '🔗', title: 'Link',
        insert: (sel) => ({ text: `[${sel || 'link text'}](url)`, cursorOffset: sel ? undefined : -1 }),
    },
    {
        label: 'heading', icon: 'H', title: 'Heading',
        insert: () => ({ text: '## ' }),
    },
    {
        label: 'bullet', icon: '•', title: 'Bullet List',
        insert: () => ({ text: '- ' }),
    },
    {
        label: 'numbered', icon: '1.', title: 'Numbered List',
        insert: () => ({ text: '1. ' }),
    },
    {
        label: 'task', icon: '☐', title: 'Task List',
        insert: () => ({ text: '- [ ] ' }),
    },
    {
        label: 'quote', icon: '❝', title: 'Blockquote',
        insert: () => ({ text: '> ' }),
    },
    {
        label: 'math', icon: '∑', title: 'Math Block',
        insert: () => ({ text: '$$\n\n$$', cursorOffset: -3 }),
    },
    {
        label: 'table', icon: '⊞', title: 'Table',
        insert: () => ({
            text: '| Column 1 | Column 2 | Column 3 |\n|----------|----------|----------|\n|          |          |          |\n',
        }),
    },
    {
        label: 'codeblock', icon: '{ }', title: 'Code Block',
        insert: (sel) => ({ text: `\`\`\`\n${sel || ''}\n\`\`\``, cursorOffset: sel ? undefined : -4 }),
    },
];

// ── Math delimiter preprocessor ───────────────────────────────────────────────
// Converts common LaTeX-style math delimiters to the $$/$ syntax that
// remark-math recognises, so users can write \[...\], \(...\), or a
// standalone [ ... ] block and have it render correctly in read mode.

function preprocessMathDelimiters(text: string): string {
    // \[ ... \] → $$ ... $$ (LaTeX display math)
    let result = text.replace(/\\\[([\s\S]*?)\\\]/g, (_, math) => `$$${math}$$`);
    // \( ... \) → $ ... $ (LaTeX inline math)
    result = result.replace(/\\\(([\s\S]*?)\\\)/g, (_, math) => `$${math}$`);
    // Standalone bare brackets on their own lines:
    //   [
    //   S \div R = T(X)
    //   ]
    // → $$\nS \div R = T(X)\n$$
    result = result.replace(
        /^[ \t]*\[[ \t]*\n([\s\S]*?)\n[ \t]*\][ \t]*$/gm,
        (_, math) => `$$\n${math.trim()}\n$$`,
    );
    return result;
}

// ── Image helpers ─────────────────────────────────────────────────────────────

function generateImageName(ext: string): string {
    const timestamp = Date.now();
    const rand = Math.random().toString(36).substring(2, 8);
    return `image-${timestamp}-${rand}.${ext}`;
}

function getFileDir(filePath: string): string {
    const sep = filePath.includes('/') ? '/' : '\\';
    const parts = filePath.split(sep);
    parts.pop();
    return parts.join(sep);
}

function getNoteName(filePath: string): string {
    const name = filePath.split(/[\\/]/).pop() ?? '';
    return name.replace(/\.md$/i, '');
}

// ── Async image component for read-mode rendering ─────────────────────────────
// Loads images via IPC (readFile) and converts to data URIs so they display
// correctly regardless of webSecurity / same-origin restrictions.

const NoteImage: React.FC<{ src?: string; alt?: string; fileDir: string }> = ({ src, alt, fileDir }) => {
    const [dataUri, setDataUri] = useState<string | null>(null);
    const [error, setError] = useState(false);

    useEffect(() => {
        if (!src) { setError(true); return; }
        if (src.startsWith('http') || src.startsWith('data:')) {
            setDataUri(src);
            return;
        }

        const cleanSrc = src.replace(/^\.\//, '').replace(/^\.\\/, '');
        const sep = fileDir.includes('/') ? '/' : '\\';
        const fullPath = src.startsWith('file:///')
            ? decodeURIComponent(src.replace('file:///', ''))
            : `${fileDir}${sep}${cleanSrc}`;

        window.electronAPI.readFile(fullPath)
            .then((bytes) => {
                const ext = fullPath.split('.').pop()?.toLowerCase() || 'png';
                const mimeMap: Record<string, string> = {
                    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
                    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
                };
                const mime = mimeMap[ext] || 'image/png';
                let binary = '';
                for (let i = 0; i < bytes.length; i++) {
                    binary += String.fromCharCode(bytes[i]);
                }
                setDataUri(`data:${mime};base64,${btoa(binary)}`);
            })
            .catch(() => setError(true));
    }, [src, fileDir]);

    if (error) return <span className="text-[#666] text-xs italic">[image not found]</span>;
    if (!dataUri) return <span className="text-[#4e4e4e] text-xs">Loading image…</span>;
    return <img src={dataUri} alt={alt || 'image'} className="notes-embedded-image" />;
};

// ── CodeMirror inline image preview widget ────────────────────────────────────
// Scans document for ![...](path) patterns pointing to local images and renders
// a preview widget below the line.

const IMAGE_RE = /!\[[^\]]*\]\(([^)]+)\)/g;
const IMAGE_EXTS = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;

class ImageWidget extends WidgetType {
    constructor(readonly src: string, readonly fileDir: string) { super(); }

    eq(other: ImageWidget): boolean {
        return other.src === this.src && other.fileDir === this.fileDir;
    }

    toDOM(): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'cm-image-preview';
        wrap.style.cssText = 'padding:4px 0 8px;max-width:100%;';

        const img = document.createElement('img');
        img.style.cssText = 'max-width:100%;max-height:300px;border-radius:6px;display:block;';
        img.alt = 'preview';

        // Resolve relative path to absolute and load via IPC
        const cleanSrc = this.src.replace(/^\.\//, '').replace(/^\.\\/, '');
        const sep = this.fileDir.includes('/') ? '/' : '\\';
        const fullPath = `${this.fileDir}${sep}${cleanSrc}`;

        window.electronAPI.readFile(fullPath)
            .then((bytes) => {
                const ext = fullPath.split('.').pop()?.toLowerCase() || 'png';
                const mimeMap: Record<string, string> = {
                    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
                    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
                };
                const mime = mimeMap[ext] || 'image/png';
                let binary = '';
                for (let i = 0; i < bytes.length; i++) {
                    binary += String.fromCharCode(bytes[i]);
                }
                img.src = `data:${mime};base64,${btoa(binary)}`;
            })
            .catch(() => {
                img.style.display = 'none';
            });

        wrap.appendChild(img);
        return wrap;
    }

    ignoreEvent(): boolean { return true; }
}

function buildImageDecorations(state: EditorState, fileDir: string): DecorationSet {
    const widgets: Range<Decoration>[] = [];
    const doc = state.doc;

    for (let i = 1; i <= doc.lines; i++) {
        const line = doc.line(i);
        let match: RegExpExecArray | null;
        IMAGE_RE.lastIndex = 0;
        while ((match = IMAGE_RE.exec(line.text)) !== null) {
            const src = match[1];
            if (IMAGE_EXTS.test(src) && !src.startsWith('http')) {
                widgets.push(
                    Decoration.widget({
                        widget: new ImageWidget(src, fileDir),
                        block: true,
                    }).range(line.to),
                );
            }
        }
    }

    return Decoration.set(widgets, true);
}

function imagePreviewPlugin(fileDir: string) {
    return StateField.define<DecorationSet>({
        create(state) {
            return buildImageDecorations(state, fileDir);
        },
        update(value, tr) {
            if (tr.docChanged) {
                return buildImageDecorations(tr.state, fileDir);
            }
            return value;
        },
        provide: (f) => EditorView.decorations.from(f),
    });
}

// ── Component ─────────────────────────────────────────────────────────────────

export const NotesEditor: React.FC<NotesEditorProps> = ({ filePath, noteId, vaultPath }) => {
    const editorRef = useRef<HTMLDivElement>(null);
    const editorAreaRef = useRef<HTMLDivElement>(null);
    const readViewRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const [mode, setMode] = useState<ViewMode>('write');
    const [content, setContent] = useState('');
    const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
    const [pdfStatus, setPdfStatus] = useState<'idle' | 'exporting' | 'done' | 'error'>('idle');
    const [loaded, setLoaded] = useState(false);
    const [conflict, setConflict] = useState<{ pendingContent: string } | null>(null);
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const contentRef = useRef(content);
    const lastLoadedAtRef = useRef<number>(Math.floor(Date.now() / 1000));
    /** Saved scroll fraction (0..1) to restore after mode switch */
    const savedScrollFractionRef = useRef<number | null>(null);

    const fileDir = useMemo(() => getFileDir(filePath), [filePath]);
    const noteName = useMemo(() => getNoteName(filePath), [filePath]);

    // Keep contentRef in sync
    useEffect(() => { contentRef.current = content; }, [content]);

    // Pre-process content for the read view: normalise math delimiters so that
    // \[...\], \(...\), and standalone [ ... ] blocks all render via KaTeX.
    const processedContent = useMemo(() => preprocessMathDelimiters(content), [content]);

    // ── Load note on mount ──────────────────────────────────────────────────
    useEffect(() => {
        let cancelled = false;

        const load = async () => {
            try {
                const note = await window.electronAPI.readNote(vaultPath, noteId);
                if (!cancelled) {
                    setContent(note.content);
                    lastLoadedAtRef.current = Math.floor(Date.now() / 1000);
                    setLoaded(true);
                    window.dispatchEvent(new CustomEvent('noteOpened', { detail: { noteId } }));
                }
            } catch (err) {
                console.error('[NotesEditor] Failed to load note:', err);
                // If note doesn't exist in DB, try reading file directly
                try {
                    const buf = await window.electronAPI.readFile(filePath);
                    const text = new TextDecoder().decode(buf);
                    if (!cancelled) {
                        setContent(text);
                        lastLoadedAtRef.current = Math.floor(Date.now() / 1000);
                        setLoaded(true);
                    }
                } catch (err2) {
                    console.error('[NotesEditor] Failed to read file:', err2);
                    if (!cancelled) {
                        setContent('');
                        setLoaded(true);
                    }
                }
            }
        };

        void load();
        return () => { cancelled = true; };
    }, [filePath, noteId, vaultPath]);

    // ── Autosave ────────────────────────────────────────────────────────────
    const triggerSave = useCallback((newContent: string, forceOverwrite = false) => {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);

        saveTimerRef.current = setTimeout(async () => {
            setSaveStatus('saving');
            try {
                if (noteId) {
                    const loadedAt = forceOverwrite ? undefined : lastLoadedAtRef.current;
                    const result = await window.electronAPI.updateNote(vaultPath, noteId, newContent, loadedAt);
                    if (result && !result.ok && 'reason' in result && result.reason === 'conflict') {
                        setConflict({ pendingContent: newContent });
                        setSaveStatus('idle');
                        return;
                    }
                    // Successful save — update lastLoadedAt so future saves use the new baseline
                    lastLoadedAtRef.current = Math.floor(Date.now() / 1000);
                } else {
                    const encoder = new TextEncoder();
                    await window.electronAPI.writeFile(filePath, encoder.encode(newContent));
                    lastLoadedAtRef.current = Math.floor(Date.now() / 1000);
                }
                setSaveStatus('saved');
                setTimeout(() => setSaveStatus('idle'), 2000);
            } catch (err) {
                console.error('[NotesEditor] Save failed:', err);
                setSaveStatus('idle');
            }
        }, forceOverwrite ? 0 : 1000);
    }, [noteId, vaultPath, filePath]);

    // ── Conflict resolution handlers ────────────────────────────────────────
    const handleConflictOverwrite = useCallback(() => {
        if (!conflict) return;
        setConflict(null);
        triggerSave(conflict.pendingContent, true);
    }, [conflict, triggerSave]);

    const handleConflictDiscard = useCallback(async () => {
        setConflict(null);
        try {
            const note = await window.electronAPI.readNote(vaultPath, noteId);
            setContent(note.content);
            lastLoadedAtRef.current = Math.floor(Date.now() / 1000);
            // Update CodeMirror if in write mode
            const view = viewRef.current;
            if (view) {
                view.dispatch({
                    changes: { from: 0, to: view.state.doc.length, insert: note.content },
                });
            }
        } catch {
            // Fallback: read from disk
            try {
                const buf = await window.electronAPI.readFile(filePath);
                const text = new TextDecoder().decode(buf);
                setContent(text);
                lastLoadedAtRef.current = Math.floor(Date.now() / 1000);
                const view = viewRef.current;
                if (view) {
                    view.dispatch({
                        changes: { from: 0, to: view.state.doc.length, insert: text },
                    });
                }
            } catch (err2) {
                console.error('[NotesEditor] Failed to reload after conflict:', err2);
            }
        }
    }, [vaultPath, noteId, filePath]);

    // ── Image paste/drop handler ────────────────────────────────────────────
    const insertImageIntoEditor = useCallback(async (imageData: ArrayBuffer, ext: string) => {
        const view = viewRef.current;
        if (!view) return;

        const fileName = generateImageName(ext);
        const sep = fileDir.includes('/') ? '/' : '\\';
        const imageDir = `${fileDir}${sep}${noteName}`;
        try {
            await window.electronAPI.saveImage(imageDir, fileName, new Uint8Array(imageData));
            const mdRef = `![image](./${noteName}/${fileName})`;
            const pos = view.state.selection.main.head;
            const insertText = pos > 0 && view.state.doc.sliceString(pos - 1, pos) !== '\n'
                ? `\n${mdRef}\n`
                : `${mdRef}\n`;
            view.dispatch({
                changes: { from: pos, insert: insertText },
                selection: { anchor: pos + insertText.length },
            });
            view.focus();
        } catch (err) {
            console.error('[NotesEditor] Image save failed:', err);
        }
    }, [fileDir, noteName]);

    // ── CodeMirror setup ────────────────────────────────────────────────────
    const extensions = useMemo(() => [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        drawSelection(),
        rectangularSelection(),
        bracketMatching(),
        closeBrackets(),
        history(),
        autocompletion(),
        highlightSelectionMatches(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        markdown({ base: markdownLanguage }),
        oneDark,
        keymap.of([
            ...defaultKeymap,
            ...historyKeymap,
            ...closeBracketsKeymap,
            ...searchKeymap,
            indentWithTab,
        ]),
        EditorView.lineWrapping,
        scrollPastEnd(),
        EditorView.theme({
            '&': { height: '100%', background: '#141414' },
            '.cm-scroller': { overflow: 'auto', fontFamily: "'JetBrains Mono', 'Fira Code', 'Consolas', monospace", fontSize: '14px' },
            '.cm-content': { maxWidth: '750px', margin: '0 auto', padding: '40px 24px 80px' },
            '.cm-gutters': { background: '#1a1a1a', borderRight: '1px solid #2a2a2a', color: '#4a4a4a' },
            '.cm-activeLineGutter': { background: '#222' },
            '.cm-activeLine': { background: 'rgba(255,255,255,0.03)' },
            '.cm-cursor': { borderLeftColor: '#4a9eff' },
            '.cm-selectionBackground': { background: 'rgba(74,158,255,0.2) !important' },
        }),
        imagePreviewPlugin(fileDir),
    ], [fileDir]);

    // ── Initialize / destroy CodeMirror ─────────────────────────────────────
    useEffect(() => {
        if (!editorRef.current || !loaded || mode === 'read') return;

        const state = EditorState.create({
            doc: content,
            extensions: [
                ...extensions,
                EditorView.updateListener.of((update) => {
                    if (update.docChanged) {
                        const newDoc = update.state.doc.toString();
                        setContent(newDoc);
                        triggerSave(newDoc);
                    }
                }),
            ],
        });

        const view = new EditorView({
            state,
            parent: editorRef.current,
        });

        viewRef.current = view;

        // ── Paste handler for images ──
        const handlePaste = (e: ClipboardEvent) => {
            const items = e.clipboardData?.items;
            if (!items) return;
            for (const item of Array.from(items)) {
                if (item.type.startsWith('image/')) {
                    e.preventDefault();
                    const blob = item.getAsFile();
                    if (!blob) continue;
                    const ext = item.type.split('/')[1] || 'png';
                    void blob.arrayBuffer().then((buf) => insertImageIntoEditor(buf, ext));
                    return;
                }
            }
        };

        // ── Drop handler for images ──
        const handleDrop = (e: DragEvent) => {
            const files = e.dataTransfer?.files;
            if (!files || files.length === 0) return;
            for (const file of Array.from(files)) {
                if (file.type.startsWith('image/')) {
                    e.preventDefault();
                    const ext = file.name.split('.').pop() || 'png';
                    void file.arrayBuffer().then((buf) => insertImageIntoEditor(buf, ext));
                    return;
                }
            }
        };

        const editorDom = view.dom;
        editorDom.addEventListener('paste', handlePaste);
        editorDom.addEventListener('drop', handleDrop);

        return () => {
            editorDom.removeEventListener('paste', handlePaste);
            editorDom.removeEventListener('drop', handleDrop);
            view.destroy();
            viewRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loaded, mode, extensions, triggerSave, insertImageIntoEditor]);

    // ── Refresh editor when content is appended from FloatingActionBar ─────
    useEffect(() => {
        const handler = async (e: Event) => {
            const { noteId: appendedId } = (e as CustomEvent<{ noteId: string }>).detail;
            if (appendedId !== noteId) return;
            try {
                const note = await window.electronAPI.readNote(vaultPath, noteId);
                setContent(note.content);
                lastLoadedAtRef.current = Math.floor(Date.now() / 1000);
                // Update CodeMirror editor if it's active
                const view = viewRef.current;
                if (view) {
                    const currentDoc = view.state.doc.toString();
                    if (currentDoc !== note.content) {
                        view.dispatch({
                            changes: { from: 0, to: currentDoc.length, insert: note.content },
                        });
                    }
                }
            } catch (err) {
                console.error('[NotesEditor] Failed to refresh after append:', err);
            }
        };
        window.addEventListener('noteContentAppended', handler);
        return () => window.removeEventListener('noteContentAppended', handler);
    }, [noteId, vaultPath]);

    // ── Live append from notes:appendChunk IPC broadcast ──────────────────
    // When another window (or this one) appends a chunk to the note currently
    // open in the editor, reload from disk so CodeMirror stays in sync.
    useEffect(() => {
        const cleanup = window.electronAPI.onNoteLiveAppend((payload) => {
            if (payload.noteId !== noteId) return;
            // Re-read from disk to pick up the freshly written content
            window.electronAPI.readNote(vaultPath, noteId)
                .then((note) => {
                    setContent(note.content);
                    lastLoadedAtRef.current = Math.floor(Date.now() / 1000);
                    const view = viewRef.current;
                    if (view) {
                        const currentDoc = view.state.doc.toString();
                        if (currentDoc !== note.content) {
                            view.dispatch({
                                changes: { from: 0, to: currentDoc.length, insert: note.content },
                            });
                        }
                    }
                })
                .catch((err) => {
                    console.error('[NotesEditor] Failed to refresh after liveAppend:', err);
                });
        });
        return cleanup;
    }, [noteId, vaultPath]);

    // ── Helper: capture scroll position (raw pixels) before mode switch ─────
    const saveScrollPosition = useCallback(() => {
        if (mode === 'write') {
            const scroller = viewRef.current?.scrollDOM;
            if (scroller) {
                savedScrollFractionRef.current = scroller.scrollTop;
            }
        } else {
            const el = editorAreaRef.current;
            if (el) {
                savedScrollFractionRef.current = el.scrollTop;
            }
        }
    }, [mode]);

    // ── Restore scroll position after mode switch ─────────────────────────
    useEffect(() => {
        if (savedScrollFractionRef.current == null) return;
        const savedTop = savedScrollFractionRef.current;
        savedScrollFractionRef.current = null;

        // Use rAF to wait for the new view to render and lay out
        requestAnimationFrame(() => {
            if (mode === 'write') {
                const scroller = viewRef.current?.scrollDOM;
                if (scroller) {
                    scroller.scrollTop = savedTop;
                }
            } else {
                const el = editorAreaRef.current;
                if (el) {
                    el.scrollTop = savedTop;
                }
            }
        });
    }, [mode]);

    // ── Keyboard shortcut: Ctrl+E toggles modes ────────────────────────────
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e') {
                e.preventDefault();
                saveScrollPosition();
                setMode((prev) => prev === 'write' ? 'read' : 'write');
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [saveScrollPosition]);

    // ── Toolbar action handler ─────────────────────────────────────────────
    const handleToolbarAction = useCallback((action: ToolbarAction) => {
        const view = viewRef.current;
        if (!view) return;

        const { from, to } = view.state.selection.main;
        const selectedText = view.state.sliceDoc(from, to);
        const result = action.insert(selectedText);

        view.dispatch({
            changes: { from, to, insert: result.text },
            selection: result.cursorOffset != null
                ? { anchor: from + result.text.length + result.cursorOffset }
                : { anchor: from + result.text.length },
        });
        view.focus();
    }, []);

    // ── Custom image component for ReactMarkdown ──────────────────────────
    // For display: uses NoteImage which loads via IPC (data URIs)
    const markdownComponents = useMemo(() => ({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        img: ({ src, alt, ...props }: any) => (
            <NoteImage src={src} alt={alt} fileDir={fileDir} />
        ),
        // Open links in the user's default browser instead of navigating in-app
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        a: ({ href, children, ...props }: any) => {
            const handleClick = (e: React.MouseEvent) => {
                if (href && /^https?:\/\//i.test(href)) {
                    e.preventDefault();
                    window.electronAPI.openExternal(href);
                }
            };
            return <a href={href} onClick={handleClick} {...props}>{children}</a>;
        },
    }), [fileDir]);

    // For PDF export hidden view: uses raw relative paths that the PDF export
    // code can resolve and inline as data URIs.
    const pdfMarkdownComponents = useMemo(() => ({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        img: ({ src, alt, ...props }: any) => {
            let resolvedSrc = src;
            if (src && !src.startsWith('http') && !src.startsWith('data:') && !src.startsWith('file:')) {
                const sep = fileDir.includes('/') ? '/' : '\\';
                const cleanSrc = src.replace(/^\.\//, '').replace(/^\.\\/, '');
                resolvedSrc = `file:///${fileDir.replace(/\\/g, '/')}/${cleanSrc.replace(/\\/g, '/')}`;
            }
            return <img src={resolvedSrc} alt={alt || 'image'} {...props} className="notes-embedded-image" />;
        },
    }), [fileDir]);

    // ── PDF export ──────────────────────────────────────────────────────────
    const handleExportPdf = useCallback(async () => {
        setPdfStatus('exporting');

        // Give React a paint to ensure the hidden read view is up to date
        await new Promise<void>((resolve) => setTimeout(resolve, 80));

        const bodyHtml = readViewRef.current?.innerHTML ?? '';

        // Convert all relative image <img src="file:///..."> to base64 data URIs
        // so the PDF includes them
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = bodyHtml;
        const images = tempDiv.querySelectorAll('img');
        for (const img of Array.from(images)) {
            const imgSrc = img.getAttribute('src') || '';
            if (imgSrc.startsWith('file:///') || (!imgSrc.startsWith('http') && !imgSrc.startsWith('data:'))) {
                try {
                    // Resolve the actual file path from the src
                    let actualPath: string;
                    if (imgSrc.startsWith('file:///')) {
                        actualPath = decodeURIComponent(imgSrc.replace('file:///', ''));
                    } else {
                        const sep = fileDir.includes('/') ? '/' : '\\';
                        const cleanSrc = imgSrc.replace(/^\.\//, '').replace(/^\.\\/, '');
                        actualPath = `${fileDir}${sep}${cleanSrc}`;
                    }
                    const imageBytes = await window.electronAPI.readFile(actualPath);
                    const ext = actualPath.split('.').pop()?.toLowerCase() || 'png';
                    const mimeMap: Record<string, string> = {
                        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
                        gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
                    };
                    const mime = mimeMap[ext] || 'image/png';
                    // Convert to base64
                    let binary = '';
                    for (let i = 0; i < imageBytes.length; i++) {
                        binary += String.fromCharCode(imageBytes[i]);
                    }
                    const base64 = btoa(binary);
                    img.setAttribute('src', `data:${mime};base64,${base64}`);
                } catch (err) {
                    console.error('[NotesEditor] Failed to inline image for PDF:', err);
                }
            }
        }

        // Collect all stylesheets active in this renderer (includes KaTeX CSS etc.)
        // Only extract KaTeX CSS — we need it for math rendering but we must
        // NOT include the app's dark-mode/overflow/height styles or the PDF
        // will show only one page with gray text.
        const katexCSS = Array.from(document.styleSheets)
            .flatMap((sheet) => {
                try {
                    return Array.from(sheet.cssRules).map((r) => r.cssText);
                } catch {
                    return [];
                }
            })
            .filter((rule) => rule.includes('.katex') || rule.trimStart().startsWith('@font-face'))
            .join('\n');

        const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
/* ── KaTeX (math rendering) ── */
${katexCSS}
/* ── Document / typography ── */
@page { size: A4; margin: 2cm; }
html, body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif !important;
  font-size: 15px !important;
  line-height: 1.7 !important;
  color: #1a1a1a !important;
  background: #ffffff !important;
  max-width: 760px;
  margin: 0 auto !important;
  padding: 0 !important;
  height: auto !important;
  overflow: visible !important;
}
* { box-sizing: border-box; }
h1,h2,h3,h4,h5,h6 { margin-top: 1.4em !important; margin-bottom: 0.5em !important; font-weight: 600 !important; color: #111111 !important; }
h1 { font-size: 2em !important; border-bottom: 1px solid #ddd; padding-bottom: 0.3em; }
h2 { font-size: 1.5em !important; border-bottom: 1px solid #eee; padding-bottom: 0.2em; }
h3 { font-size: 1.25em !important; }
h4,h5,h6 { font-size: 1em !important; }
p { margin: 0.8em 0 !important; color: #1a1a1a !important; }
a { color: #0366d6 !important; }
code { background: #f0f0f0 !important; padding: 0.15em 0.35em !important; border-radius: 3px; font-size: 0.88em !important; color: #1a1a1a !important; }
pre { background: #f6f8fa !important; border: 1px solid #ddd !important; border-radius: 6px; padding: 1em !important; overflow-x: auto; page-break-inside: avoid; }
pre code { background: none !important; padding: 0 !important; font-size: 0.85em !important; }
blockquote { border-left: 4px solid #dfe2e5 !important; padding-left: 1em !important; margin-left: 0 !important; color: #6a737d !important; }
table { border-collapse: collapse !important; width: 100% !important; margin: 1em 0 !important; page-break-inside: avoid; }
th, td { border: 1px solid #dfe2e5 !important; padding: 0.5em 0.75em !important; color: #1a1a1a !important; }
th { background: #f6f8fa !important; font-weight: 600 !important; }
tr:nth-child(even) td { background: #fafafa !important; }
img { max-width: 100% !important; border-radius: 6px; margin: 0.5em 0; }
input[type="checkbox"] { margin-right: 0.4em; }
hr { border: none !important; border-top: 1px solid #ddd !important; margin: 1.5em 0 !important; }
ul, ol { padding-left: 1.5em !important; margin: 0.5em 0 !important; }
li { margin: 0.2em 0 !important; color: #1a1a1a !important; }
.task-list-item { list-style: none !important; margin-left: -1.5em !important; }
</style>
</head>
<body>
<div>${tempDiv.innerHTML}</div>
</body>
</html>`;

        try {
            await window.electronAPI.exportNotePdf(html, filePath, vaultPath);
            setPdfStatus('done');
            setTimeout(() => setPdfStatus('idle'), 3000);
        } catch (err) {
            console.error('[NotesEditor] PDF export failed:', err);
            setPdfStatus('error');
            setTimeout(() => setPdfStatus('idle'), 3000);
        }
    }, [filePath, fileDir, vaultPath]);

    if (!loaded) {
        return (
            <div className="notes-editor">
                <div className="flex-1 flex items-center justify-center">
                    <span className="text-[#4e4e4e] text-sm">Loading…</span>
                </div>
            </div>
        );
    }

    return (
        <div className="notes-editor">
            {/* ── Toolbar ── */}
            <div className="notes-toolbar">
                {/* Formatting buttons — only in write mode */}
                {mode === 'write' && (
                    <div className="notes-toolbar-group">
                        {TOOLBAR_ACTIONS.map((action, i) => (
                            <React.Fragment key={action.label}>
                                {(action.label === 'heading' || action.label === 'quote' || action.label === 'math' || action.label === 'codeblock') && (
                                    <span className="notes-toolbar-sep" />
                                )}
                                <button
                                    type="button"
                                    className="notes-toolbar-btn"
                                    title={action.title}
                                    onClick={() => handleToolbarAction(action)}
                                    style={action.label === 'bold' ? { fontWeight: 700 } : action.label === 'italic' ? { fontStyle: 'italic' } : undefined}
                                >
                                    {action.icon}
                                </button>
                            </React.Fragment>
                        ))}
                    </div>
                )}

                {/* Save indicator */}
                <span className={`notes-save-indicator ${saveStatus}`}>
                    {saveStatus === 'saving' ? '● Saving…' : saveStatus === 'saved' ? '✓ Saved' : ''}
                </span>

                {/* Mode toggle + PDF export */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginLeft: 'auto' }}>
                    <div className="notes-mode-toggle">
                        <button
                            type="button"
                            className={`notes-mode-btn ${mode === 'write' ? 'active' : ''}`}
                            onClick={() => { saveScrollPosition(); setMode('write'); }}
                        >
                            Write
                        </button>
                        <button
                            type="button"
                            className={`notes-mode-btn ${mode === 'read' ? 'active' : ''}`}
                            onClick={() => { saveScrollPosition(); setMode('read'); }}
                        >
                            Read
                        </button>
                    </div>
                    <button
                        type="button"
                        className="notes-mode-btn"
                        title="Export to PDF (saved next to file)"
                        disabled={pdfStatus === 'exporting'}
                        onClick={() => { void handleExportPdf(); }}
                        style={{ minWidth: '56px' }}
                    >
                        {pdfStatus === 'exporting' ? '⏳ PDF' : pdfStatus === 'done' ? '✓ PDF' : pdfStatus === 'error' ? '✗ PDF' : '↓ PDF'}
                    </button>
                </div>
            </div>

            {/* ── Editor / Read view ── */}
            <div ref={editorAreaRef} className={`notes-editor-area${mode === 'read' ? ' read-mode' : ''}`}>
                {mode === 'read' ? (
                    <div className="notes-read-view" ref={readViewRef}>
                        <ReactMarkdown
                            remarkPlugins={[remarkGfm, remarkMath]}
                            rehypePlugins={[rehypeKatex, rehypeRaw]}
                            components={markdownComponents}
                        >
                            {processedContent}
                        </ReactMarkdown>
                    </div>
                ) : (
                    // Keep a hidden read view mounted so PDF export can capture it
                    // even when triggered from write mode.
                    <>
                        <div ref={editorRef} style={{ height: '100%' }} />
                        <div
                            className="notes-read-view"
                            ref={readViewRef}
                            style={{ display: 'none', position: 'absolute', pointerEvents: 'none' }}
                        >
                            <ReactMarkdown
                                remarkPlugins={[remarkGfm, remarkMath]}
                                rehypePlugins={[rehypeKatex, rehypeRaw]}
                                components={pdfMarkdownComponents}
                            >
                                {processedContent}
                            </ReactMarkdown>
                        </div>
                    </>
                )}
            </div>

            {/* ── Conflict modal ── */}
            {conflict && (
                <div style={{
                    position: 'absolute', inset: 0, display: 'flex',
                    alignItems: 'center', justifyContent: 'center',
                    background: 'rgba(0,0,0,0.6)', zIndex: 1000,
                }}>
                    <div style={{
                        background: '#1e1e1e', border: '1px solid #333',
                        borderRadius: 8, padding: '24px 28px', maxWidth: 420,
                        display: 'flex', flexDirection: 'column', gap: 12,
                    }}>
                        <h3 style={{ margin: 0, fontSize: 15, color: '#e0e0e0' }}>
                            Save Conflict
                        </h3>
                        <p style={{ margin: 0, fontSize: 13, color: '#999', lineHeight: 1.5 }}>
                            This file was modified by another window since you loaded it.
                            Your changes may overwrite those edits.
                        </p>
                        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
                            <button
                                type="button"
                                onClick={() => { void handleConflictDiscard(); }}
                                style={{
                                    padding: '6px 14px', fontSize: 13, borderRadius: 5,
                                    border: '1px solid #444', background: '#2a2a2a',
                                    color: '#ccc', cursor: 'pointer',
                                }}
                            >
                                Discard my changes &amp; reload
                            </button>
                            <button
                                type="button"
                                onClick={handleConflictOverwrite}
                                style={{
                                    padding: '6px 14px', fontSize: 13, borderRadius: 5,
                                    border: 'none', background: '#c53030',
                                    color: '#fff', cursor: 'pointer',
                                }}
                            >
                                Overwrite
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};
