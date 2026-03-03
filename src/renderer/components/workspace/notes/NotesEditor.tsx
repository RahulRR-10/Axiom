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

// ── Component ─────────────────────────────────────────────────────────────────

export const NotesEditor: React.FC<NotesEditorProps> = ({ filePath, noteId, vaultPath }) => {
    const editorRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const [mode, setMode] = useState<ViewMode>('write');
    const [content, setContent] = useState('');
    const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
    const [loaded, setLoaded] = useState(false);
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const contentRef = useRef(content);

    // Keep contentRef in sync
    useEffect(() => { contentRef.current = content; }, [content]);

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

    // ── Render ──────────────────────────────────────────────────────────────

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

                {/* Mode toggle */}
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
            </div>

            {/* ── Editor / Read view ── */}
            <div className="notes-editor-area">
                {mode === 'read' ? (
                    <div className="notes-read-view">
                        <ReactMarkdown
                            remarkPlugins={[remarkGfm, remarkMath]}
                            rehypePlugins={[rehypeKatex, rehypeRaw]}
                        >
                            {content}
                        </ReactMarkdown>
                    </div>
                ) : (
                    <div ref={editorRef} style={{ height: '100%' }} />
                )}
            </div>
        </div>
    );
};
