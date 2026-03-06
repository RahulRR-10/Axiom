import React, { useState, useEffect, useCallback, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import type {
  Annotation,
  HighlightAnnotation,
  StickyAnnotation,
  DrawAnnotation,
  TextboxAnnotation,
} from '../../../../shared/types';
import type { PDFTool } from './PDFToolbar';

type Props = {
  activeTool:          PDFTool;
  highlightColor:      string;
  fileId:              string;
  page:                number;
  vaultPath:           string;
  cssWidth:            number;
  cssHeight:           number;
  wrapperRef:          React.RefObject<HTMLDivElement>;
  annotations:         Annotation[];
  onAnnotationCreated: (ann: Annotation) => void;
  onAnnotationDeleted: (annId: string) => void;
  fontSize:            number;
  textColor:           string;
  zoom:                number;
};

type StickyPopover = { id: string | null; x: number; y: number; content: string };

/**
 * Renders annotation elements as DIRECT children of the page wrapper
 * (React Fragment — no container div that could block text selection).
 * All coordinates stored normalized (0-1).
 */
export const AnnotationLayer: React.FC<Props> = ({
  activeTool,
  highlightColor,
  fileId,
  page,
  vaultPath,
  cssWidth,
  cssHeight,
  wrapperRef,
  annotations,
  onAnnotationCreated,
  onAnnotationDeleted,
  fontSize: propFontSize,
  textColor: propTextColor,
  zoom: propZoom,
}) => {
  const [newHighlights, setNewHighlights] = useState<HighlightAnnotation[]>([]);
  const [newDrawings, setNewDrawings]     = useState<DrawAnnotation[]>([]);
  const [popover, setPopover]             = useState<StickyPopover | null>(null);
  const [textboxEdit, setTextboxEdit]     = useState<{ x: number; y: number; content: string } | null>(null);

  // Refs to always have the latest text color / font size (avoids stale closures in onBlur)
  const textColorRef = useRef(propTextColor);
  const fontSizeRef  = useRef(propFontSize);
  useEffect(() => { textColorRef.current = propTextColor; }, [propTextColor]);
  useEffect(() => { fontSizeRef.current  = propFontSize; },  [propFontSize]);

  // ── Draw state ──────────────────────────────────────────────────────────
  const [drawing, setDrawing]             = useState(false);
  const [drawPoints, setDrawPoints]       = useState<Array<{ x: number; y: number }>>([]);
  const drawRef                           = useRef(false);

  /* ══════════════════════════════════════════════════════════════════════════
     HIGHLIGHT TOOL
  ══════════════════════════════════════════════════════════════════════════ */
  const handleMouseUp = useCallback(() => {
    if (activeTool !== 'highlight') return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const text = sel.toString().trim();
    if (!text || !wrapperRef.current) return;

    const wrapRect = wrapperRef.current.getBoundingClientRect();
    const range    = sel.getRangeAt(0);
    const ancestor = range.commonAncestorContainer;
    const within   = wrapperRef.current === ancestor
      || wrapperRef.current.contains(
        ancestor.nodeType === Node.TEXT_NODE ? ancestor.parentNode as Node : ancestor,
      );
    if (!within) return;

    const wrapW = wrapRect.width || 1;
    const wrapH = wrapRect.height || 1;
    const rects = Array.from(range.getClientRects())
      .filter(r => r.width > 0 && r.height > 0)
      .map(r => ({
        x: (r.left - wrapRect.left) / wrapW,
        y: (r.top  - wrapRect.top)  / wrapH,
        w: r.width  / wrapW,
        h: r.height / wrapH,
      }));
    if (!rects.length) { sel.removeAllRanges(); return; }

    // Clear mode: remove overlapping highlights instead of creating new ones
    if (highlightColor === 'clear') {
      const allHl = [
        ...annotations.filter((a): a is HighlightAnnotation => a.type === 'highlight' && a.page === page),
        ...newHighlights.filter(a => a.page === page),
      ];
      for (const hl of allHl) {
        const overlaps = hl.rects.some(hr =>
          rects.some(sr =>
            sr.x < hr.x + hr.w && sr.x + sr.w > hr.x &&
            sr.y < hr.y + hr.h && sr.y + sr.h > hr.y
          )
        );
        if (overlaps) {
          setNewHighlights(prev => prev.filter(a => a.id !== hl.id));
          onAnnotationDeleted(hl.id);
        }
      }
      sel.removeAllRanges();
      return;
    }

    const ann: HighlightAnnotation = {
      id: uuidv4(), file_id: fileId, page, type: 'highlight',
      rects, color: highlightColor, text,
    };
    setNewHighlights(prev => [...prev, ann]);
    onAnnotationCreated(ann);
    sel.removeAllRanges();
  }, [activeTool, highlightColor, fileId, page, vaultPath, wrapperRef, onAnnotationCreated, annotations, newHighlights, onAnnotationDeleted]);

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    el.addEventListener('mouseup', handleMouseUp);
    return () => el.removeEventListener('mouseup', handleMouseUp);
  }, [wrapperRef, handleMouseUp]);

  /* ══════════════════════════════════════════════════════════════════════════
     STICKY NOTE TOOL
  ══════════════════════════════════════════════════════════════════════════ */
  const handleStickyClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (activeTool !== 'sticky') return;
      const rect = e.currentTarget.getBoundingClientRect();
      setPopover({
        id: null,
        x: (e.clientX - rect.left) / (rect.width  || 1),
        y: (e.clientY - rect.top)  / (rect.height || 1),
        content: '',
      });
    },
    [activeTool],
  );

  const saveSticky = () => {
    if (!popover) return;
    const ann: StickyAnnotation = {
      id: uuidv4(), file_id: fileId, page, type: 'sticky',
      x: popover.x, y: popover.y, content: popover.content,
    };
    onAnnotationCreated(ann);
    setPopover(null);
  };

  /* ══════════════════════════════════════════════════════════════════════════
     FREEHAND DRAW TOOL
  ══════════════════════════════════════════════════════════════════════════ */
  const getRelPos = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      return {
        x: (e.clientX - rect.left) / (rect.width  || 1),
        y: (e.clientY - rect.top)  / (rect.height || 1),
      };
    },
    [],
  );

  const handleDrawDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (activeTool !== 'draw') return;
      e.preventDefault();
      const pt = getRelPos(e);
      setDrawPoints([pt]);
      setDrawing(true);
      drawRef.current = true;
    },
    [activeTool, getRelPos],
  );

  const handleDrawMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!drawRef.current) return;
      const pt = getRelPos(e);
      setDrawPoints(prev => [...prev, pt]);
    },
    [getRelPos],
  );

  const handleDrawUp = useCallback(() => {
    if (!drawRef.current) return;
    drawRef.current = false;
    setDrawing(false);
    setDrawPoints(prev => {
      if (prev.length < 2) return [];
      const ann: DrawAnnotation = {
        id: uuidv4(), file_id: fileId, page, type: 'draw',
        points: prev, color: highlightColor, strokeWidth: 2,
      };
      setNewDrawings(d => [...d, ann]);
      onAnnotationCreated(ann);
      return [];
    });
  }, [fileId, page, vaultPath, highlightColor, onAnnotationCreated]);

  /* ══════════════════════════════════════════════════════════════════════════
     ERASER TOOL
  ══════════════════════════════════════════════════════════════════════════ */
  const handleEraserClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (activeTool !== 'eraser') return;
      const rect = e.currentTarget.getBoundingClientRect();
      const cx = (e.clientX - rect.left) / (rect.width  || 1);
      const cy = (e.clientY - rect.top)  / (rect.height || 1);
      const threshold = 0.03; // ~3% of page — generous hit area

      // Find nearest annotation to delete
      const allAnns = [...annotations, ...newHighlights, ...newDrawings];
      let hit: Annotation | null = null;

      for (const ann of allAnns) {
        if (ann.page !== page) continue;
        if (ann.type === 'highlight') {
          for (const r of ann.rects) {
            if (cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h) {
              hit = ann; break;
            }
          }
        } else if (ann.type === 'sticky') {
          if (Math.abs(cx - ann.x) < threshold && Math.abs(cy - ann.y) < threshold) {
            hit = ann;
          }
        } else if (ann.type === 'draw') {
          for (const pt of ann.points) {
            if (Math.abs(cx - pt.x) < threshold && Math.abs(cy - pt.y) < threshold) {
              hit = ann; break;
            }
          }
        }
        if (hit) break;
      }

      if (hit) {
        // Remove from local state
        setNewHighlights(prev => prev.filter(a => a.id !== hit!.id));
        setNewDrawings(prev => prev.filter(a => a.id !== hit!.id));
        // Mark for deletion
        onAnnotationDeleted(hit.id);
      }
    },
    [activeTool, annotations, newHighlights, newDrawings, page, onAnnotationDeleted],
  );

  /* ═══════════════════════════════════════════════════════════════════════════
     MERGE ANNOTATIONS
  ═══════════════════════════════════════════════════════════════════════════ */
  const allHighlights = [
    ...annotations.filter((a): a is HighlightAnnotation => a.type === 'highlight'),
    ...newHighlights,
  ].filter((a, i, arr) => arr.findIndex(b => b.id === a.id) === i);

  const allStickies = annotations.filter(
    (a): a is StickyAnnotation => a.type === 'sticky',
  );

  const allDrawings = [
    ...annotations.filter((a): a is DrawAnnotation => a.type === 'draw'),
    ...newDrawings,
  ].filter((a, i, arr) => arr.findIndex(b => b.id === a.id) === i);

  const allTextboxes = annotations.filter(
    (a): a is TextboxAnnotation => a.type === 'textbox',
  );

  /* ═══════════════════════════════════════════════════════════════════════════
     HELPER: SVG points string
  ═══════════════════════════════════════════════════════════════════════════ */
  const toSvgPoints = (pts: Array<{ x: number; y: number }>) =>
    pts.map(p => `${p.x * cssWidth},${p.y * cssHeight}`).join(' ');

  /* ═══════════════════════════════════════════════════════════════════════════
     RENDER — all elements via Fragment, no container div
  ═══════════════════════════════════════════════════════════════════════════ */
  return (
    <>
      {/* ── Tool interaction layer (sticky / draw / eraser / textbox) ── */}
      {(activeTool === 'sticky' || activeTool === 'draw' || activeTool === 'eraser' || activeTool === 'textbox') && (
        <div
          style={{
            position: 'absolute', top: 0, left: 0,
            width: cssWidth, height: cssHeight,
            pointerEvents: 'all',
            cursor: activeTool === 'eraser' ? 'pointer' : 'crosshair',
            zIndex: 5,
          }}
          onClick={
            activeTool === 'sticky' ? handleStickyClick
            : activeTool === 'eraser' ? handleEraserClick
            : activeTool === 'textbox' ? (() => {
                // Single click: dismiss the active textbox (commit if it has content)
                if (textboxEdit) {
                  if (textboxEdit.content.trim()) {
                    const ann: TextboxAnnotation = {
                      id: uuidv4(), file_id: fileId, page, type: 'textbox',
                      x: textboxEdit.x, y: textboxEdit.y,
                      content: textboxEdit.content, color: textColorRef.current, fontSize: fontSizeRef.current,
                    };
                    onAnnotationCreated(ann);
                  }
                  setTextboxEdit(null);
                }
              })
            : undefined
          }
          onDoubleClick={
            activeTool === 'textbox' ? ((e: React.MouseEvent<HTMLDivElement>) => {
                const rect = e.currentTarget.getBoundingClientRect();
                setTextboxEdit({
                  x: (e.clientX - rect.left) / (rect.width || 1),
                  y: (e.clientY - rect.top) / (rect.height || 1),
                  content: '',
                });
              })
            : undefined
          }
          onMouseDown={activeTool === 'draw' ? handleDrawDown : undefined}
          onMouseMove={activeTool === 'draw' ? handleDrawMove : undefined}
          onMouseUp={activeTool === 'draw' ? handleDrawUp : undefined}
          onMouseLeave={activeTool === 'draw' ? handleDrawUp : undefined}
        />
      )}

      {/* ── Highlight rects ── */}
      {allHighlights.map(h =>
        h.rects.map((r, i) => (
          <div
            key={`hl-${h.id}-${i}`}
            style={{
              position: 'absolute',
              top: r.y * cssHeight, left: r.x * cssWidth,
              width: r.w * cssWidth, height: r.h * cssHeight,
              background: h.color, opacity: 0.4, mixBlendMode: 'multiply',
              borderRadius: 2, pointerEvents: 'none', zIndex: 3,
            }}
          />
        )),
      )}

      {/* ── Draw strokes (SVG) ── */}
      {(allDrawings.length > 0 || drawing) && (
        <svg
          style={{
            position: 'absolute', top: 0, left: 0,
            width: cssWidth, height: cssHeight,
            pointerEvents: 'none', zIndex: 3, overflow: 'visible',
          }}
        >
          {allDrawings.map(d => (
            <polyline
              key={`dr-${d.id}`}
              points={toSvgPoints(d.points)}
              fill="none"
              stroke={d.color}
              strokeWidth={d.strokeWidth}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
          {/* Live drawing preview */}
          {drawing && drawPoints.length > 1 && (
            <polyline
              points={toSvgPoints(drawPoints)}
              fill="none"
              stroke={highlightColor}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray="4 2"
            />
          )}
        </svg>
      )}

      {/* ── Sticky note pins ── */}
      {allStickies.map(s => (
        <div
          key={`st-${s.id}`}
          style={{
            position: 'absolute',
            top: s.y * cssHeight - 12, left: s.x * cssWidth - 8,
            pointerEvents: 'all', zIndex: 5,
            display: 'flex', alignItems: 'flex-start', gap: '2px',
          }}
        >
          <button
            type="button"
            style={{
              background: 'transparent', border: 'none',
              cursor: 'pointer', fontSize: '20px', lineHeight: 1,
              padding: 0,
            }}
            onClick={e => { e.stopPropagation(); setPopover({ id: s.id, x: s.x, y: s.y, content: s.content }); }}
            title="Sticky note"
          >
            📌
          </button>
          <button
            type="button"
            onClick={e => {
              e.stopPropagation();
              setNewHighlights(prev => prev.filter(a => a.id !== s.id));
              onAnnotationDeleted(s.id);
            }}
            title="Delete note"
            style={{
              background: 'rgba(0,0,0,0.6)', border: 'none', borderRadius: '50%',
              width: '16px', height: '16px', cursor: 'pointer',
              color: '#ccc', fontSize: '10px', lineHeight: 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              padding: 0, flexShrink: 0,
            }}
          >
            ✕
          </button>
        </div>
      ))}

      {/* ── Sticky popover ── */}
      {popover && (
        <div
          style={{
            position: 'absolute',
            top: popover.y * cssHeight, left: popover.x * cssWidth,
            background: '#fffde7', borderRadius: '8px', padding: '12px',
            minWidth: '200px', boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
            zIndex: 20, pointerEvents: 'all',
          }}
          onClick={e => e.stopPropagation()}
        >
          <textarea
            autoFocus value={popover.content}
            onChange={e => setPopover(p => p ? { ...p, content: e.target.value } : p)}
            placeholder="Add a note…" rows={4}
            style={{
              width: '100%', background: 'transparent', border: 'none',
              outline: 'none', resize: 'none', fontFamily: 'inherit',
              fontSize: '13px', color: '#333',
            }}
          />
          <div className="flex justify-end gap-2 mt-2">
            <button type="button" onClick={() => setPopover(null)}
              className="text-xs text-gray-500 hover:text-gray-700 px-2 py-1">Cancel</button>
            <button type="button" onClick={saveSticky}
              className="text-xs bg-yellow-400 text-yellow-900 px-3 py-1 rounded hover:bg-yellow-500">Save</button>
          </div>
        </div>
      )}

      {/* ── Saved textbox annotations ── */}
      {allTextboxes.map(tb => (
        <div
          key={`tb-${tb.id}`}
          style={{
            position: 'absolute',
            top: tb.y * cssHeight,
            left: tb.x * cssWidth,
            pointerEvents: 'all',
            zIndex: 4,
            display: 'flex',
            alignItems: 'flex-start',
            gap: '2px',
          }}
        >
          <div
            style={{
              color: tb.color,
              fontSize: `${tb.fontSize * propZoom}px`,
              fontFamily: 'sans-serif',
              whiteSpace: 'pre-wrap',
              maxWidth: `${cssWidth - tb.x * cssWidth - 24}px`,
              lineHeight: 1.3,
              textShadow: '0 0 2px rgba(0,0,0,0.5)',
            }}
          >
            {tb.content}
          </div>
          <button
            type="button"
            onClick={e => {
              e.stopPropagation();
              onAnnotationDeleted(tb.id);
            }}
            title="Delete text"
            style={{
              background: 'rgba(0,0,0,0.6)', border: 'none', borderRadius: '50%',
              width: '16px', height: '16px', cursor: 'pointer',
              color: '#ccc', fontSize: '10px', lineHeight: 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              padding: 0, flexShrink: 0,
            }}
          >
            ✕
          </button>
        </div>
      ))}

      {/* ── Active textbox input ── */}
      {textboxEdit && (
        <div
          style={{
            position: 'absolute',
            top: textboxEdit.y * cssHeight,
            left: textboxEdit.x * cssWidth,
            zIndex: 20,
            pointerEvents: 'all',
          }}
          onClick={e => e.stopPropagation()}
        >
          <textarea
            autoFocus
            rows={1}
            value={textboxEdit.content}
            onChange={e => setTextboxEdit(prev => prev ? { ...prev, content: e.target.value } : prev)}
            onKeyDown={e => {
              if (e.key === 'Escape') {
                e.preventDefault();
                setTextboxEdit(null);
              }
              // Allow Enter as a newline — do not commit on Enter
            }}
            onBlur={() => {
              if (textboxEdit.content.trim()) {
                const ann: TextboxAnnotation = {
                  id: uuidv4(), file_id: fileId, page, type: 'textbox',
                  x: textboxEdit.x, y: textboxEdit.y,
                  content: textboxEdit.content, color: textColorRef.current, fontSize: fontSizeRef.current,
                };
                onAnnotationCreated(ann);
                setTextboxEdit(null);
              } else {
                setTextboxEdit(null);
              }
            }}
            placeholder="Type here…"
            style={{
              background: 'rgba(0,0,0,0.7)',
              border: `1px solid ${propTextColor}`,
              borderRadius: '4px',
              color: propTextColor,
              fontSize: `${propFontSize}px`,
              fontFamily: 'sans-serif',
              padding: '4px 8px',
              outline: 'none',
              minWidth: '150px',
              resize: 'both',
              overflow: 'auto',
            }}
          />
        </div>
      )}
    </>
  );
};
