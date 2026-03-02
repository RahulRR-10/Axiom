import React, { useState, useEffect, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import type { Annotation, HighlightAnnotation, StickyAnnotation } from '../../../../shared/types';
import type { PDFTool } from './PDFToolbar';

type Props = {
  activeTool:        PDFTool;
  fileId:            string;
  page:              number;
  vaultPath:         string;
  cssWidth:          number;
  cssHeight:         number;
  /** Ref to the page wrapper div — coordinate origin for rects */
  wrapperRef:        React.RefObject<HTMLDivElement>;
  annotations:       Annotation[];
  onAnnotationSaved: () => void;
};

type StickyPopover = {
  id:      string | null; // null = new sticky
  x:       number;
  y:       number;
  content: string;
};

export const AnnotationLayer: React.FC<Props> = ({
  activeTool,
  fileId,
  page,
  vaultPath,
  cssWidth,
  cssHeight,
  wrapperRef,
  annotations,
  onAnnotationSaved,
}) => {
  const [newHighlights, setNewHighlights] = useState<HighlightAnnotation[]>([]);
  const [popover, setPopover]             = useState<StickyPopover | null>(null);

  // ── Highlight tool: capture text-layer selection rects ────────────────────
  const handleMouseUp = useCallback(() => {
    if (activeTool !== 'highlight') return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;

    const text = sel.toString().trim();
    if (!text || !wrapperRef.current) return;

    const wrapRect = wrapperRef.current.getBoundingClientRect();
    const range    = sel.getRangeAt(0);
    const domRects = Array.from(range.getClientRects());

    const rects = domRects
      .filter(r => r.width > 0 && r.height > 0)
      .map(r => ({
        x: r.left - wrapRect.left,
        y: r.top  - wrapRect.top,
        w: r.width,
        h: r.height,
      }));

    if (!rects.length) return;
    sel.removeAllRanges();

    const annotation: HighlightAnnotation = {
      id:      uuidv4(),
      file_id: fileId,
      page,
      type:    'highlight',
      rects,
      color:   '#fde68a',
      text,
    };

    window.electronAPI
      .saveAnnotation(vaultPath, annotation)
      .then(() => {
        setNewHighlights(prev => [...prev, annotation]);
        onAnnotationSaved();
      })
      .catch(console.error);
  }, [activeTool, fileId, page, vaultPath, wrapperRef, onAnnotationSaved]);

  // Attach mouseup to the wrapper so we capture selections across text layer
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    el.addEventListener('mouseup', handleMouseUp);
    return () => el.removeEventListener('mouseup', handleMouseUp);
  }, [wrapperRef, handleMouseUp]);

  // ── Sticky tool: click-catcher overlay ───────────────────────────────────
  const handleStickyClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (activeTool !== 'sticky') return;
      const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
      setPopover({ id: null, x: e.clientX - rect.left, y: e.clientY - rect.top, content: '' });
    },
    [activeTool],
  );

  const saveSticky = () => {
    if (!popover) return;
    const annotation: StickyAnnotation = {
      id:      uuidv4(),
      file_id: fileId,
      page,
      type:    'sticky',
      x:       popover.x,
      y:       popover.y,
      content: popover.content,
    };
    window.electronAPI
      .saveAnnotation(vaultPath, annotation)
      .then(() => {
        setPopover(null);
        onAnnotationSaved();
      })
      .catch(console.error);
  };

  // Dedup persisted + newly placed highlights
  const allHighlights = [
    ...annotations.filter((a): a is HighlightAnnotation => a.type === 'highlight'),
    ...newHighlights,
  ].filter((a, i, arr) => arr.findIndex(b => b.id === a.id) === i);

  const allStickies = annotations.filter(
    (a): a is StickyAnnotation => a.type === 'sticky',
  );

  return (
    <>
      {/* ── Sticky click-catcher (only when sticky tool active) ── */}
      {activeTool === 'sticky' && (
        <div
          style={{
            position:      'absolute',
            top:           0,
            left:          0,
            width:         cssWidth,
            height:        cssHeight,
            pointerEvents: 'all',
            cursor:        'crosshair',
            zIndex:        3,
          }}
          onClick={handleStickyClick}
        />
      )}

      {/* ── Annotation overlay (pointer-events none — text layer stays selectable) ── */}
      <div
        style={{
          position:      'absolute',
          top:           0,
          left:          0,
          width:         cssWidth,
          height:        cssHeight,
          pointerEvents: 'none',
          zIndex:        4,
        }}
      >
        {/* Highlight rects */}
        {allHighlights.map(h =>
          h.rects.map((r, i) => (
            <div
              key={`${h.id}-${i}`}
              style={{
                position:      'absolute',
                top:           r.y,
                left:          r.x,
                width:         r.w,
                height:        r.h,
                background:    h.color,
                opacity:       0.4,
                mixBlendMode:  'multiply',
                borderRadius:  2,
                pointerEvents: 'none',
              }}
            />
          )),
        )}

        {/* Sticky note pins */}
        {allStickies.map(s => (
          <button
            key={s.id}
            type="button"
            style={{
              position:      'absolute',
              top:           s.y - 12,
              left:          s.x - 8,
              background:    'transparent',
              border:        'none',
              cursor:        'pointer',
              fontSize:      '20px',
              lineHeight:    1,
              padding:       0,
              pointerEvents: 'all',
            }}
            onClick={e => {
              e.stopPropagation();
              setPopover({ id: s.id, x: s.x, y: s.y, content: s.content });
            }}
            title="Sticky note"
          >
            📌
          </button>
        ))}

        {/* New / edit sticky popover */}
        {popover && (
          <div
            style={{
              position:      'absolute',
              top:           popover.y,
              left:          popover.x,
              background:    '#fffde7',
              borderRadius:  '8px',
              padding:       '12px',
              minWidth:      '200px',
              boxShadow:     '0 4px 16px rgba(0,0,0,0.5)',
              zIndex:        20,
              pointerEvents: 'all',
            }}
            onClick={e => e.stopPropagation()}
          >
            <textarea
              autoFocus
              value={popover.content}
              onChange={e => setPopover(p => p ? { ...p, content: e.target.value } : p)}
              placeholder="Add a note…"
              rows={4}
              style={{
                width:      '100%',
                background: 'transparent',
                border:     'none',
                outline:    'none',
                resize:     'none',
                fontFamily: 'inherit',
                fontSize:   '13px',
                color:      '#333',
              }}
            />
            <div className="flex justify-end gap-2 mt-2">
              <button
                type="button"
                onClick={() => setPopover(null)}
                className="text-xs text-gray-500 hover:text-gray-700 px-2 py-1"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={saveSticky}
                className="text-xs bg-yellow-400 text-yellow-900 px-3 py-1 rounded hover:bg-yellow-500"
              >
                Save
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
};
