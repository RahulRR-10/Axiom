import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';

import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, rectangularSelection } from '@codemirror/view';
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
        /^[ \t]*\[[ \t]*$([\s\S]*?)^[ \t]*\][ \t]*$/gm,
        (_, math) => `$$\n${math.trim()}\n$$`,
    );
    return result;
}

// ── Component ─────────────────────────────────────────────────────────────────

export const NotesEditor: React.FC<NotesEditorProps> = ({ filePath, noteId, vaultPath }) => {
    const editorRef = useRef<HTMLDivElement>(null);
    const readViewRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const [mode, setMode] = useState<ViewMode>('write');
    const [content, setContent] = useState('');
    const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
    const [pdfStatus, setPdfStatus] = useState<'idle' | 'exporting' | 'done' | 'error'>('idle');
    const [loaded, setLoaded] = useState(false);
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const contentRef = useRef(content);

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
                    setLoaded(true);
                }
            } catch (err) {
                console.error('[NotesEditor] Failed to load note:', err);
                // If note doesn't exist in DB, try reading file directly
                try {
                    const buf = await window.electronAPI.readFile(filePath);
                    const text = new TextDecoder().decode(buf);
                    if (!cancelled) {
                        setContent(text);
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
    const triggerSave = useCallback((newContent: string) => {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);

        saveTimerRef.current = setTimeout(async () => {
            setSaveStatus('saving');
            try {
                if (noteId) {
                    await window.electronAPI.updateNote(vaultPath, noteId, newContent);
                } else {
                    const encoder = new TextEncoder();
                    await window.electronAPI.writeFile(filePath, encoder.encode(newContent));
                }
                setSaveStatus('saved');
                setTimeout(() => setSaveStatus('idle'), 2000);
            } catch (err) {
                console.error('[NotesEditor] Save failed:', err);
                setSaveStatus('idle');
            }
        }, 1000);
    }, [noteId, vaultPath, filePath]);

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
    ], []);

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

        return () => {
            view.destroy();
            viewRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loaded, mode, extensions, triggerSave]);

    // ── Keyboard shortcut: Ctrl+E toggles modes ────────────────────────────
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e') {
                e.preventDefault();
                setMode((prev) => prev === 'write' ? 'read' : 'write');
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, []);

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

    // ── PDF export ──────────────────────────────────────────────────────────
    const handleExportPdf = useCallback(async () => {
        setPdfStatus('exporting');

        // Give React a paint to ensure the hidden read view is up to date
        await new Promise<void>((resolve) => setTimeout(resolve, 80));

        const bodyHtml = readViewRef.current?.innerHTML ?? '';

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
img { max-width: 100% !important; }
input[type="checkbox"] { margin-right: 0.4em; }
hr { border: none !important; border-top: 1px solid #ddd !important; margin: 1.5em 0 !important; }
ul, ol { padding-left: 1.5em !important; margin: 0.5em 0 !important; }
li { margin: 0.2em 0 !important; color: #1a1a1a !important; }
.task-list-item { list-style: none !important; margin-left: -1.5em !important; }
</style>
</head>
<body>
<div>${bodyHtml}</div>
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
    }, [filePath]);

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
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <div className="notes-mode-toggle">
                        <button
                            type="button"
                            className={`notes-mode-btn ${mode === 'write' ? 'active' : ''}`}
                            onClick={() => setMode('write')}
                        >
                            Write
                        </button>
                        <button
                            type="button"
                            className={`notes-mode-btn ${mode === 'read' ? 'active' : ''}`}
                            onClick={() => setMode('read')}
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
            <div className={`notes-editor-area${mode === 'read' ? ' read-mode' : ''}`}>
                {mode === 'read' ? (
                    <div className="notes-read-view" ref={readViewRef}>
                        <ReactMarkdown
                            remarkPlugins={[remarkGfm, remarkMath]}
                            rehypePlugins={[rehypeKatex, rehypeRaw]}
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
                            >
                                {processedContent}
                            </ReactMarkdown>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
};
