import React, { useEffect, useRef, useState, useCallback } from 'react';
import { ChevronDown } from 'lucide-react';

type AITarget = 'claude' | 'chatgpt' | 'gemini';
const AI_TARGETS: AITarget[] = ['claude', 'chatgpt', 'gemini'];

type Position = { top: number; left: number };

type Props = {
  /** Container element to anchor mouse-up listener on */
  containerRef: React.RefObject<HTMLElement>;
  currentPage:  number;
  filePath:     string;
};

export const FloatingActionBar: React.FC<Props> = ({
  containerRef,
  currentPage,
  filePath,
}) => {
  const [pos, setPos]             = useState<Position | null>(null);
  const [selectedText, setSelectedText] = useState('');
  const [aiOpen, setAiOpen]       = useState(false);
  const [hlOpen, setHlOpen]       = useState(false);
  const barRef                    = useRef<HTMLDivElement>(null);

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

    // Position is relative to the container's content (including scroll offset)
    return {
      text,
      pos: {
        top:  rect.top  - containerRect.top  + container.scrollTop  - 40, // 8px above
        left: rect.left - containerRect.left + container.scrollLeft + rect.width / 2,
      },
    };
  }, [containerRef]);

  // Show bar after text selection
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onMouseUp = () => {
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
  const dispatchHighlight = (color: string) => {
    window.dispatchEvent(new CustomEvent('floatingHighlight', {
      detail: { text: selectedText, color, page: currentPage },
    }));
    setPos(null);
  };

  if (!pos) return null;

  const HL_COLORS = [
    { label: 'Yellow', value: '#fde68a' },
    { label: 'Green',  value: '#a7f3d0' },
    { label: 'Pink',   value: '#fbb6ce' },
    { label: 'Blue',   value: '#93c5fd' },
  ];

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
      {/* Highlight ▾ */}
      <div className="relative">
        <button
          type="button"
          onClick={() => { setHlOpen(o => !o); setAiOpen(false); }}
          className="flex items-center gap-1 px-2 py-1 text-xs text-[#d4d4d4] rounded hover:bg-[#3a3a3a] transition-colors"
        >
          Highlight <ChevronDown size={12} />
        </button>
        {hlOpen && (
          <div
            style={{
              position: 'absolute',
              top: '100%',
              left: 0,
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
                onClick={() => dispatchHighlight(c.value)}
                title={c.label}
                style={{ background: c.value }}
                className="w-6 h-6 rounded border border-[#555] hover:scale-110 transition-transform"
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
