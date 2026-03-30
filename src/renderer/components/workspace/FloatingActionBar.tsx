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
  highlightColor: string;
  onHighlightColorChange: (color: string) => void;
  /** Subject of the currently open source file (folder name), for ranking notes */
  sourceSubject?: string | null;
  onAnnotationCreated: (ann: Annotation) => void;
  annotations?: Annotation[];
  onAnnotationDeleted?: (annId: string) => void;
};

/**
 * Resolve which page a text layer belongs to.
 */
function getPageNum(textLayer: HTMLElement): number {
  const wrapper = textLayer.parentElement;
  if (!wrapper?.parentElement) return 1;
  const siblings = wrapper.parentElement.children;
  for (let i = 0; i < siblings.length; i++) {
    if (siblings[i] === wrapper) return i + 1;
  }
  return 1;
}

/**
 * Build highlight annotation(s) from the current browser selection.
 * Uses span-level bounding rects to avoid including non-text DOM elements.
 * Returns one annotation per page so cross-page selections work.
 */
function buildHighlightFromSelection(
  fileId: string,
  color: string,
): { annotation: HighlightAnnotation; page: number }[] | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;

  const text = sel.toString().trim();
  if (!text) return null;

  const range = sel.getRangeAt(0);

  // Find all .textLayer elements that the selection touches.
  // Start from the range's start/end containers and walk up to find text layers.
  const getTextLayer = (node: Node): HTMLElement | null => {
    const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement);
    return el?.closest('.textLayer') as HTMLElement | null;
  };

  const startTL = getTextLayer(range.startContainer);
  const endTL = getTextLayer(range.endContainer);
  if (!startTL && !endTL) return null;

  // Collect the set of text layers involved
  const textLayers: HTMLElement[] = [];
  if (startTL) textLayers.push(startTL);
  if (startTL && endTL && startTL !== endTL) {
    // Add any intermediate text layers between start and end
    const startWrapper = startTL.parentElement;
    const endWrapper = endTL.parentElement;
    const parent = startWrapper?.parentElement;
    if (parent && startWrapper && endWrapper) {
      let inRange = false;
      for (let i = 0; i < parent.children.length; i++) {
        const child = parent.children[i];
        if (child === startWrapper) { inRange = true; continue; }
        if (child === endWrapper) break;
        if (inRange) {
          const tl = child.querySelector('.textLayer') as HTMLElement | null;
          if (tl) textLayers.push(tl);
        }
      }
    }
    textLayers.push(endTL);
  } else if (!startTL && endTL) {
    textLayers.push(endTL);
  }

  // For each text layer, find selected spans and collect their rects
  const pageGroups = new Map<number, { wrapper: HTMLElement; rects: DOMRect[] }>();

  for (const tl of textLayers) {
    const wrapper = tl.parentElement;
    if (!wrapper) continue;
    const pageNum = getPageNum(tl);
    const spans = tl.querySelectorAll('span:not([role="img"])');

    for (const span of spans) {
      // Check if this span is at least partially within the selection
      if (!sel.containsNode(span, true)) continue;

      // For the start/end spans, create a clipped sub-range
      // For fully-contained spans, use the span's full bounding rect
      let rects: DOMRectList | DOMRect[];

      const spanContainsStart = span.contains(range.startContainer);
      const spanContainsEnd = span.contains(range.endContainer);

      if (spanContainsStart || spanContainsEnd) {
        // Partially selected span — create a sub-range strictly on its TextNode
        // to prevent `getClientRects()` from emitting duplicate overlapping rects.
        const textNode = Array.from(span.childNodes).find(n => n.nodeType === Node.TEXT_NODE) as Text | undefined;
        if (textNode) {
          const sub = document.createRange();
          
          if (spanContainsStart && (range.startContainer === textNode || range.startContainer === span)) {
            const offset = range.startContainer === textNode ? range.startOffset : (range.startOffset === 0 ? 0 : textNode.length);
            sub.setStart(textNode, offset);
          } else {
            sub.setStart(textNode, 0);
          }
          
          if (spanContainsEnd && (range.endContainer === textNode || range.endContainer === span)) {
            const offset = range.endContainer === textNode ? range.endOffset : (range.endOffset === 0 ? 0 : textNode.length);
            sub.setEnd(textNode, offset);
          } else {
            sub.setEnd(textNode, textNode.length);
          }
          
          try {
            rects = sub.getClientRects();
          } catch {
             rects = span.getClientRects(); // fallback if offsets are invalid
          }
        } else {
          // Fallback if no text node is found
          rects = span.getClientRects();
        }
      } else {
        // Fully selected span — use its bounding rects directly
        rects = span.getClientRects();
      }

      for (const r of rects) {
        if (r.width > 0 && r.height > 0) {
          if (!pageGroups.has(pageNum)) {
            pageGroups.set(pageNum, { wrapper, rects: [] });
          }
          pageGroups.get(pageNum)!.rects.push(r);
        }
      }
    }
  }

  if (pageGroups.size === 0) return null;

  const results: { annotation: HighlightAnnotation; page: number }[] = [];

  for (const [pageNum, group] of pageGroups) {
    const wrapRect = group.wrapper.getBoundingClientRect();
    const wrapW = wrapRect.width || 1;
    const wrapH = wrapRect.height || 1;

    const normalizedRects = group.rects.map(r => ({
      x: (r.left - wrapRect.left) / wrapW,
      y: (r.top  - wrapRect.top)  / wrapH,
      w: r.width  / wrapW,
      h: r.height / wrapH,
    }));

    const annotation: HighlightAnnotation = {
      id: uuidv4(), file_id: fileId, page: pageNum,
      type: 'highlight', rects: normalizedRects, color,
      text: pageGroups.size === 1 ? text : `[page ${pageNum}]`,
    };

    results.push({ annotation, page: pageNum });
  }

  return results.length > 0 ? results : null;
}

export const FloatingActionBar: React.FC<Props> = ({
  containerRef,
  currentPage,
  filePath,
  fileId,
  vaultPath,
  highlightColor,
  onHighlightColorChange,
  sourceSubject,
  onAnnotationCreated,
  annotations,
  onAnnotationDeleted,
}) => {
  type PositionInfo = {
    top: number;
    left: number;
    rects: { top: number; left: number; width: number; height: number }[];
  };
  const [pos, setPos]                   = useState<PositionInfo | null>(null);
  const [selectedText, setSelectedText] = useState('');
  const [hlOpen, setHlOpen]             = useState(false);
  const [barHighlightColor, setBarHighlightColor] = useState(highlightColor);
  const [notePopoverOpen, setNotePopoverOpen] = useState(false);
  const [aiDropdownOpen, setAiDropdownOpen] = useState(false);
  const [customPrompt, setCustomPrompt]     = useState('');
  const barRef                          = useRef<HTMLDivElement>(null);
  const textareaRef                     = useRef<HTMLTextAreaElement>(null);

  // Clear session default when vault changes
  syncSessionVault(vaultPath);

  // (Autofocus is intentionally disabled because focusing the textarea
  // natively collapses/clears the text selection in the browser.)
  useEffect(() => {
    // If we wanted to focus, we'd do it here, but it clears the selection.
  }, [aiDropdownOpen]);

  useEffect(() => {
    setBarHighlightColor(highlightColor);
  }, [highlightColor]);

  // ── Calculate bar position relative to the scrollable container ─────────
  const computePosition = useCallback(() => {
    const container = containerRef.current;
    if (!container) return null;

    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;

    const text = sel.toString().trim();
    if (!text) return null;

    const containerRect = container.getBoundingClientRect();

    // Create a temporary range at the user's cursor (focus) to get
    // an accurate rect. This completely avoids cross-page bounding box issues.
    let rect: DOMRect;
    try {
      const focusRange = document.createRange();
      if (sel.focusNode.nodeType === Node.TEXT_NODE) {
        // If it's a text node, create range over the specific character or word
        const offset = Math.max(0, sel.focusOffset - 1);
        focusRange.setStart(sel.focusNode, offset);
        focusRange.setEnd(sel.focusNode, sel.focusOffset);
      } else {
        focusRange.selectNodeContents(sel.focusNode);
      }
      rect = focusRange.getBoundingClientRect();
    } catch {
      // Fallback
      rect = sel.getRangeAt(0).getBoundingClientRect();
    }

    // Default to range bottom right if temp range fails to yield meaningful rect
    if (rect.width === 0 && rect.height === 0) {
      const clientRects = sel.getRangeAt(0).getClientRects();
      if (clientRects.length > 0) {
        rect = clientRects[clientRects.length - 1];
      } else {
        rect = sel.getRangeAt(0).getBoundingClientRect();
      }
    }

    const rawLeft = rect.left - containerRect.left + container.scrollLeft + rect.width / 2;
    const rawTop  = rect.top - containerRect.top + container.scrollTop - 40;

    // The floating bar is roughly 380px wide depending on state. With translateX(-50%), 
    // it requires ~190px clearance on each side to avoid being clipped by `overflow: auto`.
    const clampedLeft = Math.max(container.scrollLeft + 190, Math.min(container.scrollLeft + container.clientWidth - 190, rawLeft));

    // Ensure it doesn't clip off the top scroll boundary either
    const clampedTop = Math.max(container.scrollTop + 10, rawTop);

    // Also capture the raw selection rects to display a 'fake' native selection
    // when the textarea takes focus (which otherwise clears the hardware selection)
    const rawRects = Array.from(sel.getRangeAt(0).getClientRects())
      .filter(r => r.width > 0 && r.height > 0 && r.height < 100); // filter out huge container rects
    
    const fakeRects = rawRects.map(r => ({
      top: r.top - containerRect.top + container.scrollTop,
      left: r.left - containerRect.left + container.scrollLeft,
      width: r.width,
      height: r.height,
    }));

    return {
      text,
      pos: {
        top:  clampedTop,
        left: clampedLeft,
        rects: fakeRects,
      },
    };
  }, [containerRef]);

  // Show bar after text selection
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onMouseUp = (e: MouseEvent) => {
      if (barRef.current?.contains(e.target as Node)) return;

      // Only show the bar when the selection is inside a PDF text layer (not annotations)
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const anchorEl = sel.anchorNode?.nodeType === Node.TEXT_NODE
        ? sel.anchorNode.parentElement : sel.anchorNode as Element | null;
      const focusEl = sel.focusNode?.nodeType === Node.TEXT_NODE
        ? sel.focusNode.parentElement : sel.focusNode as Element | null;
      // Accept if either end of the selection is inside a text layer
      if (!anchorEl?.closest('.textLayer') && !focusEl?.closest('.textLayer')) return;

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

    const results = buildHighlightFromSelection(fileId, color);
    if (!results || results.length === 0) return;

    for (const result of results) {
      onAnnotationCreated(result.annotation);
    }
    window.getSelection()?.removeAllRanges();

    setPos(null);
    setHlOpen(false);
  }, [fileId, onAnnotationCreated, currentPage, annotations, onAnnotationDeleted]);

  useEffect(() => {
    const handler = () => doHighlight(barHighlightColor);
    window.addEventListener('toolbarHighlight', handler);
    return () => window.removeEventListener('toolbarHighlight', handler);
  }, [doHighlight, barHighlightColor]);

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
    <>
      {/* ── Fake DOM Selection Overlay ── */}
      {/* 
        When the AI textarea is focused, the browser natively collapses the 
        text selection. We render these distinct blue rectangles to visually 
        preserve the user's selection while they are interacting with the bar.
      */}
      {aiDropdownOpen && pos.rects.map((r, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            top: r.top,
            left: r.left,
            width: r.width,
            height: r.height,
            background: 'rgba(56, 139, 253, 0.25)', // Native-looking selection blue
            pointerEvents: 'none',
            zIndex: 1, // just above the text
          }}
        />
      ))}

      {/* ── The Floating Bar ── */}
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
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => doHighlight(barHighlightColor)}
          className="flex items-center gap-1 px-2 py-1 text-xs text-[#d4d4d4] rounded-l hover:bg-[#3a3a3a] transition-colors"
          title={`Highlight (${HL_COLORS.find(c => c.value === barHighlightColor)?.label ?? 'Yellow'})`}
        >
          <Highlighter size={13} />
          <span
            style={barHighlightColor === 'clear'
              ? { background: 'repeating-conic-gradient(#555 0% 25%, #333 0% 50%) 50% / 6px 6px' }
              : { background: barHighlightColor }}
            className="inline-block w-2.5 h-2.5 rounded-sm border border-[#555]"
          />
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
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
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setBarHighlightColor(c.value);
                  onHighlightColorChange(c.value);
                  setHlOpen(false);
                }}
                title={c.label}
                style={c.value === 'clear'
                  ? { background: 'repeating-conic-gradient(#555 0% 25%, #333 0% 50%) 50% / 8px 8px' }
                  : { background: c.value }}
                className={`w-6 h-6 rounded border-2 hover:scale-110 transition-transform ${
                  barHighlightColor === c.value ? 'border-white' : 'border-transparent'
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
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => dispatchSendToAI()}
          className="flex items-center gap-1 px-2 py-1 text-xs text-[#d4d4d4] rounded-l hover:bg-[#3a3a3a] transition-colors"
        >
          <Send size={13} />
          Send to AI
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
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
    </>
  );
};
