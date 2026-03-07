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
  onAnnotationUpdated: (ann: Annotation) => void;
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
  onAnnotationUpdated,
  fontSize: propFontSize,
  textColor: propTextColor,
  zoom: propZoom,
}) => {
  const [newHighlights, setNewHighlights] = useState<HighlightAnnotation[]>([]);
  const [newDrawings, setNewDrawings]     = useState<DrawAnnotation[]>([]);
  const [popover, setPopover]             = useState<StickyPopover | null>(null);
  const [textboxEdit, setTextboxEdit]     = useState<{ x: number; y: number; content: string } | null>(null);

  // ID of textbox currently being edited (existing annotation)
  const [editingTextboxId, setEditingTextboxId] = useState<string | null>(null);
  const [editingTextboxContent, setEditingTextboxContent] = useState('');
  const [editingTextboxColor, setEditingTextboxColor] = useState('#ffffff');

  // ID of sticky note being edited
  const [editingStickyId, setEditingStickyId] = useState<string | null>(null);

  // Color picker popup for textbox editing
  const [showEditColorPicker, setShowEditColorPicker] = useState(false);

  // Drag state for annotations
  const dragAnn = useRef<{ id: string; type: 'sticky' | 'textbox'; startX: number; startY: number; origX: number; origY: number } | null>(null);

  // Refs to always have the latest text color / font size
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
    if (popover.id) {
      // Update existing sticky
      const existing = allStickies.find(s => s.id === popover.id);
      if (existing) {
        onAnnotationUpdated({ ...existing, content: popover.content });
      }
      setPopover(null);
      return;
    }
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
      const threshold = 0.03;

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
        setNewHighlights(prev => prev.filter(a => a.id !== hit!.id));
        setNewDrawings(prev => prev.filter(a => a.id !== hit!.id));
        onAnnotationDeleted(hit.id);
      }
    },
    [activeTool, annotations, newHighlights, newDrawings, page, onAnnotationDeleted],
  );

  /* ═══════════════════════════════════════════════════════════════════════════
     ANNOTATION DRAGGING (sticky + textbox)
  ═══════════════════════════════════════════════════════════════════════════ */
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragAnn.current || !wrapperRef.current) return;
      const rect = wrapperRef.current.getBoundingClientRect();
      const newX = dragAnn.current.origX + (e.clientX - dragAnn.current.startX) / (rect.width || 1);
      const newY = dragAnn.current.origY + (e.clientY - dragAnn.current.startY) / (rect.height || 1);
      const clampedX = Math.max(0, Math.min(1, newX));
      const clampedY = Math.max(0, Math.min(1, newY));

      const { id, type } = dragAnn.current;
      if (type === 'sticky') {
        const ann = allStickies.find(s => s.id === id);
        if (ann) onAnnotationUpdated({ ...ann, x: clampedX, y: clampedY });
      } else {
        const ann = allTextboxes.find(t => t.id === id);
        if (ann) onAnnotationUpdated({ ...ann, x: clampedX, y: clampedY });
      }
    };

    const handleMouseUp = () => {
      dragAnn.current = null;
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [wrapperRef, onAnnotationUpdated, annotations]);

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
     TEXTBOX COLOR CHOICES
  ═══════════════════════════════════════════════════════════════════════════ */
  const textboxColors = ['#ffffff', '#ef4444', '#22c55e', '#3b82f6', '#eab308', '#ec4899', '#f97316', '#06b6d4'];

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
                // Also dismiss any editing textbox
                if (editingTextboxId) {
                  setEditingTextboxId(null);
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
      {allStickies.map(s => {
        const isEditing = editingStickyId === s.id;
        return (
          <div
            key={`st-${s.id}`}
            style={{
              position: 'absolute',
              top: s.y * cssHeight - 12, left: s.x * cssWidth - 8,
              pointerEvents: 'all', zIndex: 5,
              display: 'flex', alignItems: 'flex-start', gap: '2px',
              cursor: isEditing ? 'default' : 'grab',
            }}
            onMouseDown={e => {
              if (isEditing) return;
              e.stopPropagation();
              dragAnn.current = { id: s.id, type: 'sticky', startX: e.clientX, startY: e.clientY, origX: s.x, origY: s.y };
            }}
          >
            <button
              type="button"
              style={{
                background: 'transparent', border: 'none',
                cursor: 'pointer', fontSize: '20px', lineHeight: 1,
                padding: 0,
              }}
              onClick={e => {
                e.stopPropagation();
                setEditingStickyId(s.id);
                setPopover({ id: s.id, x: s.x, y: s.y, content: s.content });
              }}
              title="Sticky note"
            >
              📌
            </button>

          </div>
        );
      })}

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
          {/* ✕ on top-right corner of yellow box */}
          <button
            type="button"
            onClick={e => {
              e.stopPropagation();
              if (popover.id) onAnnotationDeleted(popover.id);
              setPopover(null);
              setEditingStickyId(null);
            }}
            style={{
              position: 'absolute', top: -8, right: -8,
              background: 'rgba(0,0,0,0.7)', border: 'none', borderRadius: '50%',
              width: '20px', height: '20px', cursor: 'pointer',
              color: '#fff', fontSize: '12px', lineHeight: 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              padding: 0, boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
            }}
            title="Delete note"
          >
            ✕
          </button>
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
            <button type="button" onClick={() => { setPopover(null); setEditingStickyId(null); }}
              className="text-xs text-gray-500 hover:text-gray-700 px-2 py-1">Cancel</button>
            <button type="button" onClick={() => { saveSticky(); setEditingStickyId(null); }}
              className="text-xs bg-yellow-400 text-yellow-900 px-3 py-1 rounded hover:bg-yellow-500">Save</button>
          </div>
        </div>
      )}

      {/* ── Click-outside overlay for editing textbox ── */}
      {editingTextboxId && (
        <div
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            zIndex: 19, cursor: 'default',
          }}
          onClick={() => {
            const tb = allTextboxes.find(t => t.id === editingTextboxId);
            if (tb && editingTextboxContent.trim()) {
              onAnnotationUpdated({ ...tb, content: editingTextboxContent, color: editingTextboxColor });
            } else if (tb && !editingTextboxContent.trim()) {
              onAnnotationDeleted(editingTextboxId);
            }
            setEditingTextboxId(null);
            setShowEditColorPicker(false);
          }}
        />
      )}

      {/* ── Saved textbox annotations ── */}
      {allTextboxes.map(tb => {
        const isEditing = editingTextboxId === tb.id;
        return (
          <div
            key={`tb-${tb.id}`}
            style={{
              position: 'absolute',
              top: tb.y * cssHeight,
              left: tb.x * cssWidth,
              pointerEvents: 'all',
              zIndex: isEditing ? 20 : 4,
              cursor: isEditing ? 'default' : 'grab',
            }}
            onMouseDown={e => {
              if (isEditing) return;
              e.stopPropagation();
              dragAnn.current = { id: tb.id, type: 'textbox', startX: e.clientX, startY: e.clientY, origX: tb.x, origY: tb.y };
            }}
            onDoubleClick={e => {
              e.stopPropagation();
              setEditingTextboxId(tb.id);
              setEditingTextboxContent(tb.content);
              setEditingTextboxColor(tb.color);
              setShowEditColorPicker(false);
            }}
          >
            {isEditing ? (
              <div
                onClick={e => e.stopPropagation()}
                onMouseDown={e => e.stopPropagation()}
              >
                <textarea
                  autoFocus
                  rows={1}
                  ref={ta => {
                    if (!ta) return;
                    ta.style.height = 'auto';
                    const lineH = parseFloat(getComputedStyle(ta).lineHeight) || (tb.fontSize * 1.4);
                    const maxH = lineH * 5;
                    ta.style.height = `${Math.min(ta.scrollHeight, maxH)}px`;
                    ta.style.overflowY = ta.scrollHeight > maxH ? 'auto' : 'hidden';
                  }}
                  value={editingTextboxContent}
                  onChange={e => {
                    setEditingTextboxContent(e.target.value);
                    const ta = e.target;
                    ta.style.height = 'auto';
                    const lineH = parseFloat(getComputedStyle(ta).lineHeight) || (tb.fontSize * 1.4);
                    const maxH = lineH * 5;
                    ta.style.height = `${Math.min(ta.scrollHeight, maxH)}px`;
                    ta.style.overflowY = ta.scrollHeight > maxH ? 'auto' : 'hidden';
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      setEditingTextboxId(null);
                      setShowEditColorPicker(false);
                    }
                  }}
                  style={{
                    background: 'transparent',
                    border: `1px solid ${editingTextboxColor}`,
                    borderRadius: '4px',
                    color: editingTextboxColor,
                    fontSize: `${tb.fontSize}px`,
                    fontFamily: 'sans-serif',
                    padding: '4px 8px',
                    outline: 'none',
                    minWidth: '150px',
                    resize: 'horizontal',
                    overflowY: 'hidden',
                    lineHeight: '1.4',
                  }}
                />
                {/* Compact toolbar: current color circle + delete icon */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px',
                  background: 'rgba(0,0,0,0.85)', borderRadius: '20px', padding: '5px 10px',
                  width: 'fit-content',
                }}>
                  {/* Current color circle */}
                  <div style={{ position: 'relative' }}>
                    <button
                      type="button"
                      onClick={() => setShowEditColorPicker(prev => !prev)}
                      style={{
                        width: 22, height: 22, borderRadius: '50%',
                        background: editingTextboxColor,
                        border: '2px solid #666', cursor: 'pointer', padding: 0,
                      }}
                      title="Change color"
                    />
                    {showEditColorPicker && (
                      <div style={{
                        position: 'absolute', bottom: '30px', left: '50%',
                        transform: 'translateX(-50%)',
                        display: 'flex', gap: '4px',
                        background: 'rgba(0,0,0,0.95)', borderRadius: '14px',
                        padding: '5px 8px', boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
                      }}>
                        {textboxColors.map(c => (
                          <button
                            key={c}
                            type="button"
                            onClick={() => { setEditingTextboxColor(c); setShowEditColorPicker(false); }}
                            style={{
                              width: 18, height: 18, borderRadius: '50%',
                              background: c,
                              border: editingTextboxColor === c ? '2px solid #fff' : '1px solid #555',
                              cursor: 'pointer', padding: 0, flexShrink: 0,
                            }}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                  {/* Delete icon */}
                  <button
                    type="button"
                    onClick={() => { onAnnotationDeleted(tb.id); setEditingTextboxId(null); setShowEditColorPicker(false); }}
                    style={{
                      background: 'transparent', border: 'none', cursor: 'pointer', padding: '2px',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}
                    title="Delete"
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#aaa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6"/>
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                    </svg>
                  </button>
                </div>
              </div>
            ) : (
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
            )}
          </div>
        );
      })}

      {/* ── Active textbox input (new) ── */}
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
            onChange={e => {
              setTextboxEdit(prev => prev ? { ...prev, content: e.target.value } : prev);
              const ta = e.target;
              ta.style.height = 'auto';
              const lineH = parseFloat(getComputedStyle(ta).lineHeight) || (propFontSize * 1.4);
              const maxH = lineH * 5;
              ta.style.height = `${Math.min(ta.scrollHeight, maxH)}px`;
              ta.style.overflowY = ta.scrollHeight > maxH ? 'auto' : 'hidden';
            }}
            onKeyDown={e => {
              if (e.key === 'Escape') {
                e.preventDefault();
                setTextboxEdit(null);
              }
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
              background: 'white',
              border: `1px solid ${propTextColor}`,
              borderRadius: '4px',
              color: propTextColor,
              fontSize: `${propFontSize}px`,
              fontFamily: 'sans-serif',
              padding: '4px 8px',
              outline: 'none',
              minWidth: '150px',
              resize: 'horizontal',
              overflowY: 'hidden',
              lineHeight: '1.4',
            }}
          />
        </div>
      )}
    </>
  );
};
