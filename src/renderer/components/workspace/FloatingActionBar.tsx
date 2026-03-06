import React, { useEffect, useRef, useState, useCallback } from 'react';
import { ChevronDown, Highlighter } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import type { Annotation, HighlightAnnotation } from '../../../shared/types';

type AITarget = 'claude' | 'chatgpt' | 'gemini';
const AI_TARGETS: AITarget[] = ['claude', 'chatgpt', 'gemini'];

type Position = { top: number; left: number };

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
  const [aiOpen, setAiOpen]             = useState(false);
  const [hlOpen, setHlOpen]             = useState(false);
  const [defaultColor, setDefaultColor] = useState('#fde68a');
  const barRef                          = useRef<HTMLDivElement>(null);

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
      setAiOpen(false);
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
        setAiOpen(false);
        setHlOpen(false);
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
  const dispatchSendToAI = (target: AITarget) => {
    window.dispatchEvent(new CustomEvent('sendToAI', { detail: { text: selectedText, target } }));
    setPos(null);
  };
  const dispatchSaveToNotes = () => {
    window.dispatchEvent(new CustomEvent('saveToNotes', {
      detail: { text: selectedText, sourcePage: currentPage, sourceFile: filePath },
    }));
    setPos(null);
  };

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
          onClick={() => { setHlOpen(o => !o); setAiOpen(false); }}
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

      {/* Send to AI ▾ */}
      <div className="relative">
        <button
          type="button"
          onClick={() => { setAiOpen(o => !o); setHlOpen(false); }}
          className="flex items-center gap-1 px-2 py-1 text-xs text-[#d4d4d4] rounded hover:bg-[#3a3a3a] transition-colors"
        >
          Send to AI <ChevronDown size={12} />
        </button>
        {aiOpen && (
          <div
            style={{
              position: 'absolute',
              top: '100%',
              left: 0,
              background: '#2d2d2d',
              border: '1px solid #444',
              borderRadius: '8px',
              overflow: 'hidden',
              zIndex: 1001,
            }}
          >
            {AI_TARGETS.map(t => (
              <button
                key={t}
                type="button"
                onClick={() => dispatchSendToAI(t)}
                className="block w-full text-left px-3 py-1.5 text-xs text-[#d4d4d4] capitalize hover:bg-[#3a3a3a] transition-colors"
              >
                {t === 'chatgpt' ? 'ChatGPT' : t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        )}
      </div>

      <span className="w-px h-4 bg-[#444]" />

      {/* Save to Notes */}
      <button
        type="button"
        onClick={dispatchSaveToNotes}
        className="px-2 py-1 text-xs text-[#d4d4d4] rounded hover:bg-[#3a3a3a] transition-colors"
      >
        Save to Notes
      </button>
    </div>
  );
};

