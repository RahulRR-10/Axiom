import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Check, ChevronDown, FileText, Highlighter, Send } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import type { Annotation, HighlightAnnotation, NoteSummary } from '../../../shared/types';

type Position = { top: number; left: number };

// Session-scoped: resets on app restart, shared across all instances
let sessionLastUsedNoteId: string | null = null;

const HL_COLORS = [
  { label: 'Yellow', value: '#fde68a' },
  { label: 'Green',  value: '#a7f3d0' },
  { label: 'Pink',   value: '#fbb6ce' },
  { label: 'Blue',   value: '#93c5fd' },
];

type Props = {
  /** Container element to anchor mouse-up listener on */
  containerRef: React.RefObject<HTMLElement>;
  currentPage:  number;
  filePath:     string;
  fileId:       string;
  vaultPath:    string;
  onAnnotationCreated: (ann: Annotation) => void;
};

/**
 * Build a highlight annotation from the current browser selection.
 * Returns null if the selection doesn't live inside a page wrapper.
 */
function buildHighlightFromSelection(
  fileId: string,
  color: string,
): { annotation: HighlightAnnotation; page: number } | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;

  const text = sel.toString().trim();
  if (!text) return null;

  const range    = sel.getRangeAt(0);
  const ancestor = range.commonAncestorContainer;
  const node     = ancestor.nodeType === Node.TEXT_NODE ? ancestor.parentElement : ancestor as HTMLElement;
  if (!node) return null;

  // Walk up to find the textLayer, then its parent page wrapper
  const textLayer = node.closest('.textLayer');
  if (!textLayer) return null;
  const pageWrapper = textLayer.parentElement;
  if (!pageWrapper) return null;

  // Determine page number from sibling index
  const allPages = pageWrapper.parentElement?.children;
  let pageNum = 1;
  if (allPages) {
    for (let i = 0; i < allPages.length; i++) {
      if (allPages[i] === pageWrapper) { pageNum = i + 1; break; }
    }
  }

  const wrapRect = pageWrapper.getBoundingClientRect();
  const wrapW    = wrapRect.width  || 1;
  const wrapH    = wrapRect.height || 1;

  const rects = Array.from(range.getClientRects())
    .filter(r => r.width > 0 && r.height > 0)
    .map(r => ({
      x: (r.left - wrapRect.left) / wrapW,
      y: (r.top  - wrapRect.top)  / wrapH,
      w: r.width  / wrapW,
      h: r.height / wrapH,
    }));

  if (!rects.length) return null;

  const annotation: HighlightAnnotation = {
    id: uuidv4(), file_id: fileId, page: pageNum,
    type: 'highlight', rects, color, text,
  };

  return { annotation, page: pageNum };
}

export const FloatingActionBar: React.FC<Props> = ({
  containerRef,
  currentPage,
  filePath,
  fileId,
  vaultPath,
  onAnnotationCreated,
}) => {
  const [pos, setPos]                   = useState<Position | null>(null);
  const [selectedText, setSelectedText] = useState('');
  const [hlOpen, setHlOpen]             = useState(false);
  const [defaultColor, setDefaultColor] = useState('#fde68a');
  const [noteDropdownOpen, setNoteDropdownOpen] = useState(false);
  const [allNotes, setAllNotes]         = useState<NoteSummary[] | null>(null);
  const [lastUsedNoteId, setLastUsedNoteId] = useState<string | null>(sessionLastUsedNoteId);
  const [saving, setSaving]             = useState(false);
  const [aiDropdownOpen, setAiDropdownOpen] = useState(false);
  const [customPrompt, setCustomPrompt]     = useState('');
  const barRef                          = useRef<HTMLDivElement>(null);
  const textareaRef                     = useRef<HTMLTextAreaElement>(null);

  // Focus the textarea whenever the AI dropdown opens
  useEffect(() => {
    if (aiDropdownOpen) {
      setTimeout(() => textareaRef.current?.focus(), 0);
    }
  }, [aiDropdownOpen]);

  // ── Calculate bar position relative to the scrollable container ─────────
  const computePosition = useCallback(() => {
    const container = containerRef.current;
    if (!container) return null;

    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;

    const text = sel.toString().trim();
    if (!text) return null;

    const range = sel.getRangeAt(0);
    const rect  = range.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();

    return {
      text,
      pos: {
        top:  rect.top  - containerRect.top  + container.scrollTop  - 40,
        left: rect.left - containerRect.left + container.scrollLeft + rect.width / 2,
      },
    };
  }, [containerRef]);

  // Show bar after text selection
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onMouseUp = () => {
      // Only show the bar when the selection is inside a PDF text layer (not annotations)
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const anchorEl = sel.anchorNode?.nodeType === Node.TEXT_NODE
        ? sel.anchorNode.parentElement : sel.anchorNode as Element | null;
      if (!anchorEl?.closest('.textLayer')) return;

      const result = computePosition();
      if (!result) return;

      setSelectedText(result.text);
      setHlOpen(false);
      setPos(result.pos);
    };

    container.addEventListener('mouseup', onMouseUp);
    return () => container.removeEventListener('mouseup', onMouseUp);
  }, [containerRef, computePosition]);

  // Hide bar on external mousedown
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) {
        setPos(null);
        setHlOpen(false);
        setNoteDropdownOpen(false);
        setAiDropdownOpen(false);
        setCustomPrompt('');
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, []);

  // ── Instant highlight with given color ──────────────────────────────────
  const doHighlight = useCallback((color: string) => {
    const result = buildHighlightFromSelection(fileId, color);
    if (!result) return;

    onAnnotationCreated(result.annotation);
    window.getSelection()?.removeAllRanges();

    setPos(null);
    setHlOpen(false);
  }, [fileId, onAnnotationCreated]);

  // Dispatch helpers
  const dispatchSendToAI = (prompt?: string) => {
    window.dispatchEvent(new CustomEvent('sendToAI', { detail: { text: selectedText, customPrompt: prompt || undefined } }));
    setPos(null);
    setAiDropdownOpen(false);
    setCustomPrompt('');
  };

  // ── Save to Note helpers ──────────────────────────────────────────────
  const sourceFileName = filePath.split(/[\\/]/).pop() ?? filePath;

  const doSaveToNote = useCallback(async (noteId: string) => {
    if (!vaultPath || saving) return;
    setSaving(true);
    try {
      await window.electronAPI.appendToNote(vaultPath, noteId, selectedText, sourceFileName, currentPage);
      setLastUsedNoteId(noteId);
      sessionLastUsedNoteId = noteId;
      // Notify any open NotesEditor to refresh its content
      window.dispatchEvent(new CustomEvent('noteContentAppended', { detail: { noteId } }));
      // Dispatch toast notification with the note title
      const noteTitle = allNotes?.find(n => n.id === noteId)?.title ?? noteId;
      window.dispatchEvent(new CustomEvent('noteSavedToast', { detail: { noteTitle } }));
      setPos(null);
      setNoteDropdownOpen(false);
      setAllNotes(null);
    } catch (err) {
      console.error('[FloatingActionBar] Failed to save to note:', err);
    } finally {
      setSaving(false);
    }
  }, [vaultPath, selectedText, sourceFileName, currentPage, saving]);

  // Load all notes into the dropdown
  const loadNotes = useCallback(async () => {
    if (!vaultPath) return;
    try {
      const notes = await window.electronAPI.listNotes(vaultPath);
      setAllNotes(notes);
    } catch (err) {
      console.error('[FloatingActionBar] Failed to list notes:', err);
    }
  }, [vaultPath]);

  const handleSaveClick = useCallback(async () => {
    if (lastUsedNoteId) {
      // Pre-load notes so we can find the title for the toast
      if (!allNotes) await loadNotes();
      void doSaveToNote(lastUsedNoteId);
    } else {
      // No last-used note — open the dropdown and load notes
      setNoteDropdownOpen(true);
      setHlOpen(false);
      void loadNotes();
    }
  }, [lastUsedNoteId, doSaveToNote, loadNotes, allNotes]);

  const openNoteDropdown = useCallback(() => {
    const willOpen = !noteDropdownOpen;
    setNoteDropdownOpen(willOpen);
    setHlOpen(false);
    if (!willOpen) {
      setAllNotes(null);
      return;
    }
    void loadNotes();
  }, [noteDropdownOpen, loadNotes]);

  // Listen for note opens in this session
  useEffect(() => {
    const onNoteOpened = (e: Event) => {
      const { noteId } = (e as CustomEvent).detail;
      if (noteId) {
        setLastUsedNoteId(noteId);
        sessionLastUsedNoteId = noteId;
      }
    };
    window.addEventListener('noteOpened', onNoteOpened);
    return () => window.removeEventListener('noteOpened', onNoteOpened);
  }, []);

  if (!pos) return null;

  return (
    <div
      ref={barRef}
      style={{
        position:     'absolute',
        top:          pos.top,
        left:         pos.left,
        transform:    'translateX(-50%)',
        background:   '#2d2d2d',
        border:       '1px solid #444',
        borderRadius: '8px',
        padding:      '4px 8px',
        boxShadow:    '0 4px 12px rgba(0,0,0,0.5)',
        zIndex:       1000,
        display:      'flex',
        gap:          '4px',
        alignItems:   'center',
        whiteSpace:   'nowrap',
      }}
    >
      {/* ── Highlight: click = instant, chevron = color picker ── */}
      <div className="relative flex items-center">
        <button
          type="button"
          onClick={() => doHighlight(defaultColor)}
          className="flex items-center gap-1 px-2 py-1 text-xs text-[#d4d4d4] rounded-l hover:bg-[#3a3a3a] transition-colors"
          title={`Highlight (${HL_COLORS.find(c => c.value === defaultColor)?.label ?? 'Yellow'})`}
        >
          <Highlighter size={13} />
          <span
            style={{ background: defaultColor }}
            className="inline-block w-2.5 h-2.5 rounded-sm border border-[#555]"
          />
        </button>
        <button
          type="button"
          onClick={() => { setHlOpen(o => !o); }}
          className="px-1 py-1 text-xs text-[#8a8a8a] rounded-r hover:bg-[#3a3a3a] transition-colors"
          title="Pick highlight color"
        >
          <ChevronDown size={12} />
        </button>

        {hlOpen && (
          <div
            style={{
              position: 'absolute',
              top: '100%',
              left: 0,
              marginTop: 4,
              background: '#2d2d2d',
              border: '1px solid #444',
              borderRadius: '8px',
              padding: '6px',
              display: 'flex',
              gap: '6px',
              zIndex: 1001,
            }}
          >
            {HL_COLORS.map(c => (
              <button
                key={c.value}
                type="button"
                onClick={() => {
                  setDefaultColor(c.value);
                  doHighlight(c.value);
                }}
                title={c.label}
                style={{ background: c.value }}
                className={`w-6 h-6 rounded border-2 hover:scale-110 transition-transform ${
                  defaultColor === c.value ? 'border-white' : 'border-transparent'
                }`}
              />
            ))}
          </div>
        )}
      </div>

      <span className="w-px h-4 bg-[#444]" />

      {/* Send to AI — split button with custom prompt dropdown */}
      <div className="relative flex items-center">
        <button
          type="button"
          onClick={() => dispatchSendToAI()}
          className="flex items-center gap-1 px-2 py-1 text-xs text-[#d4d4d4] rounded-l hover:bg-[#3a3a3a] transition-colors"
        >
          <Send size={13} />
          Send to AI
        </button>
        <button
          type="button"
          onClick={() => { setAiDropdownOpen(o => !o); setHlOpen(false); setNoteDropdownOpen(false); }}
          className="px-1 py-1 text-xs text-[#8a8a8a] rounded-r hover:bg-[#3a3a3a] transition-colors"
          title="Add custom prompt"
        >
          <ChevronDown size={12} />
        </button>

        {aiDropdownOpen && (
          <div
            style={{
              position: 'absolute',
              top: '100%',
              left: 0,
              marginTop: 6,
              background: '#252525',
              border: '1px solid #3a3a3a',
              borderRadius: '10px',
              padding: '10px',
              width: 280,
              zIndex: 1001,
              boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
            }}
            onMouseDown={(e) => e.stopPropagation()}
            onMouseUp={(e) => e.stopPropagation()}
          >
            <label style={{ fontSize: 10, color: '#7a7a7a', letterSpacing: '0.03em' }}>Custom prompt (optional)</label>
            <textarea
              ref={textareaRef}
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
              placeholder="Add instructions for the AI…"
              style={{
                background: '#1a1a1a',
                color: '#d4d4d4',
                fontSize: 12,
                border: '1px solid #3a3a3a',
                borderRadius: 6,
                padding: '8px',
                outline: 'none',
                resize: 'none',
                minHeight: 80,
                maxHeight: 160,
                overflowY: 'auto',
                width: '100%',
                boxSizing: 'border-box',
                lineHeight: 1.5,
                fontFamily: 'inherit',
              }}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  dispatchSendToAI(customPrompt);
                }
              }}
              onFocus={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            />
            <button
              type="button"
              onClick={() => dispatchSendToAI(customPrompt)}
              style={{
                background: '#3a3a3a',
                color: '#d4d4d4',
                fontSize: 12,
                border: 'none',
                borderRadius: 6,
                padding: '7px 12px',
                cursor: 'pointer',
                width: '100%',
                transition: 'background 0.15s',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = '#4a4a4a')}
              onMouseLeave={(e) => (e.currentTarget.style.background = '#3a3a3a')}
            >
              Send with prompt
            </button>
          </div>
        )}
      </div>

      <span className="w-px h-4 bg-[#444]" />

      {/* Save to Note — split button with dropdown */}
      <div className="relative flex items-center">
        <button
          type="button"
          onClick={handleSaveClick}
          disabled={saving}
          className="flex items-center gap-1 px-2 py-1 text-xs text-[#d4d4d4] rounded-l hover:bg-[#3a3a3a] transition-colors disabled:opacity-50"
          title={lastUsedNoteId
            ? `Save to ${allNotes?.find(n => n.id === lastUsedNoteId)?.title ?? 'last note'}`
            : 'Save to Note'}
        >
          <FileText size={13} />
          Save to Note
        </button>
        <button
          type="button"
          onClick={openNoteDropdown}
          className="px-1 py-1 text-xs text-[#8a8a8a] rounded-r hover:bg-[#3a3a3a] transition-colors"
          title="Pick target note"
        >
          <ChevronDown size={12} />
        </button>

        {noteDropdownOpen && (
          <div
            style={{
              position: 'absolute',
              top: '100%',
              right: 0,
              marginTop: 4,
              background: '#2d2d2d',
              border: '1px solid #444',
              borderRadius: '8px',
              padding: '4px 0',
              minWidth: 180,
              maxWidth: 260,
              maxHeight: 240,
              overflowY: 'auto',
              zIndex: 1001,
              boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
            }}
          >
            {allNotes === null && (
              <div className="px-3 py-2 text-xs text-[#888]">Loading…</div>
            )}
            {allNotes !== null && allNotes.length === 0 && (
              <div className="px-3 py-2 text-xs text-[#888]">No notes in vault</div>
            )}
            {allNotes?.map(note => (
              <button
                key={note.id}
                type="button"
                onClick={() => void doSaveToNote(note.id)}
                className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-[#d4d4d4] hover:bg-[#3a3a3a] transition-colors text-left"
              >
                {note.id === lastUsedNoteId
                  ? <Check size={12} className="text-[#4ade80] shrink-0" />
                  : <span className="w-3 shrink-0" />}
                <span className="truncate">{note.title}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

