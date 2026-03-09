import React, { useEffect, useRef, useState, useCallback } from 'react';
import { ChevronDown, FileText, Highlighter, Send } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import type { Annotation, HighlightAnnotation } from '../../../shared/types';
import {
  NotePickerPopover,
  getSessionDefault,
  setSessionDefault,
  syncSessionVault,
  clearSessionDefault,
} from './NotePickerPopover';

type Position = { top: number; left: number };

const HL_COLORS = [
  { label: 'Yellow', value: '#fde68a' },
  { label: 'Green',  value: '#a7f3d0' },
  { label: 'Pink',   value: '#fbb6ce' },
  { label: 'Blue',   value: '#93c5fd' },
  { label: 'Clear',  value: 'clear'   },
];

type Props = {
  /** Container element to anchor mouse-up listener on */
  containerRef: React.RefObject<HTMLElement>;
  currentPage:  number;
  filePath:     string;
  fileId:       string;
  vaultPath:    string;
  /** Subject of the currently open source file (folder name), for ranking notes */
  sourceSubject?: string | null;
  onAnnotationCreated: (ann: Annotation) => void;
  annotations?: Annotation[];
  onAnnotationDeleted?: (annId: string) => void;
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
  sourceSubject,
  onAnnotationCreated,
  annotations,
  onAnnotationDeleted,
}) => {
  const [pos, setPos]                   = useState<Position | null>(null);
  const [selectedText, setSelectedText] = useState('');
  const [hlOpen, setHlOpen]             = useState(false);
  const [defaultColor, setDefaultColor] = useState('#fde68a');
  const [notePopoverOpen, setNotePopoverOpen] = useState(false);
  const [aiDropdownOpen, setAiDropdownOpen] = useState(false);
  const [customPrompt, setCustomPrompt]     = useState('');
  const barRef                          = useRef<HTMLDivElement>(null);
  const textareaRef                     = useRef<HTMLTextAreaElement>(null);

  // Clear session default when vault changes
  syncSessionVault(vaultPath);

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
        setNotePopoverOpen(false);
        setAiDropdownOpen(false);
        setCustomPrompt('');
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, []);

  // ── Instant highlight with given color ──────────────────────────────────
  const doHighlight = useCallback((color: string) => {
    if (color === 'clear') {
      // Clear mode: erase overlapping highlight annotations on the current page
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        const ancestor = range.commonAncestorContainer;
        const node = ancestor.nodeType === Node.TEXT_NODE ? ancestor.parentElement : ancestor as HTMLElement;
        const pageWrapper = node?.closest('.textLayer')?.parentElement;
        if (pageWrapper) {
          const wrapRect = pageWrapper.getBoundingClientRect();
          const wrapW = wrapRect.width || 1;
          const wrapH = wrapRect.height || 1;
          const selRects = Array.from(range.getClientRects())
            .filter(r => r.width > 0 && r.height > 0)
            .map(r => ({
              x: (r.left - wrapRect.left) / wrapW,
              y: (r.top  - wrapRect.top)  / wrapH,
              w: r.width  / wrapW,
              h: r.height / wrapH,
            }));
          if (selRects.length && onAnnotationDeleted && annotations) {
            const hlAnns = annotations.filter(
              (a): a is HighlightAnnotation => a.type === 'highlight' && a.page === currentPage,
            );
            for (const hl of hlAnns) {
              const overlaps = hl.rects.some(hr =>
                selRects.some(sr =>
                  sr.x < hr.x + hr.w && sr.x + sr.w > hr.x &&
                  sr.y < hr.y + hr.h && sr.y + sr.h > hr.y
                )
              );
              if (overlaps) onAnnotationDeleted(hl.id);
            }
          }
        }
        sel.removeAllRanges();
      }
      setPos(null);
      setHlOpen(false);
      return;
    }

    const result = buildHighlightFromSelection(fileId, color);
    if (!result) return;

    onAnnotationCreated(result.annotation);
    window.getSelection()?.removeAllRanges();

    setPos(null);
    setHlOpen(false);
  }, [fileId, onAnnotationCreated, currentPage, annotations, onAnnotationDeleted]);

  // Dispatch helpers
  const dispatchSendToAI = (prompt?: string) => {
    window.dispatchEvent(new CustomEvent('sendToAI', { detail: { text: selectedText, customPrompt: prompt || undefined } }));
    setPos(null);
    setAiDropdownOpen(false);
    setCustomPrompt('');
  };

  // ── Save to Note helpers ──────────────────────────────────────────────
  const sourceFileName = filePath.split(/[\\/]/).pop() ?? filePath;

  const handleSaveClick = useCallback(() => {
    // Always open the popover — session default is pre-highlighted inside
    setNotePopoverOpen(true);
    setHlOpen(false);
    setAiDropdownOpen(false);
  }, []);

  const handleNoteSaved = useCallback((noteTitle: string) => {
    window.dispatchEvent(new CustomEvent('noteSavedToast', { detail: { noteTitle } }));
    setPos(null);
    setNotePopoverOpen(false);
  }, []);

  const handleNoteDeleted = useCallback(() => {
    // Note was deleted — show toast and reopen popover with fresh data
    window.dispatchEvent(
      new CustomEvent('noteSavedToast', {
        detail: { noteTitle: 'That note was deleted' },
      }),
    );
    // The popover stays open — it will refetch and show remaining notes
    setNotePopoverOpen(false);
    setTimeout(() => setNotePopoverOpen(true), 100);
  }, []);

  const handlePopoverClose = useCallback(() => {
    setNotePopoverOpen(false);
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
            style={defaultColor === 'clear'
              ? { background: 'repeating-conic-gradient(#555 0% 25%, #333 0% 50%) 50% / 6px 6px' }
              : { background: defaultColor }}
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
                style={c.value === 'clear'
                  ? { background: 'repeating-conic-gradient(#555 0% 25%, #333 0% 50%) 50% / 8px 8px' }
                  : { background: c.value }}
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
          onClick={() => { setAiDropdownOpen(o => !o); setHlOpen(false); setNotePopoverOpen(false); }}
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

      {/* Save to Note — click opens popover */}
      <div className="relative flex items-center">
        <button
          type="button"
          onClick={handleSaveClick}
          className="flex items-center gap-1 px-2 py-1 text-xs text-[#d4d4d4] rounded hover:bg-[#3a3a3a] transition-colors"
          title="Save to Note"
        >
          <FileText size={13} />
          Save to Note
        </button>

        {notePopoverOpen && (
          <NotePickerPopover
            vaultPath={vaultPath}
            sourceSubject={sourceSubject ?? null}
            selectedText={selectedText}
            sourceFile={sourceFileName}
            sourcePage={currentPage}
            onSaved={handleNoteSaved}
            onDeleted={handleNoteDeleted}
            onClose={handlePopoverClose}
          />
        )}
      </div>
    </div>
  );
};

