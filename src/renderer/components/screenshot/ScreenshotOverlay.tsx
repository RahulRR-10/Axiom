import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Full-screen overlay for region-select screenshot.
 *
 * Flow:
 *   1. Screenshot image fills the viewport as the background.
 *   2. User drags to select a region — dim overlay + selection box.
 *   3. On mouse-up the selection is finalized (NOT auto-copied).
 *   4. User can drag handles to resize, or drag the selection to move it.
 *   5. Toolbar: X (close), Copy (clipboard), Download (save to disk).
 *   6. Ctrl+C copies the current selection.
 */

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

type DragMode =
  | 'none'
  | 'selecting'       // initial draw
  | 'moving'          // drag the box
  | 'nw' | 'ne' | 'sw' | 'se'   // corner resize
  | 'n' | 's' | 'e' | 'w';      // edge resize

const HANDLE_SIZE = 10;

const CURSOR_MAP: Record<string, string> = {
  nw: 'nwse-resize', se: 'nwse-resize',
  ne: 'nesw-resize', sw: 'nesw-resize',
  n: 'ns-resize', s: 'ns-resize',
  e: 'ew-resize', w: 'ew-resize',
  moving: 'move',
};

export const ScreenshotOverlay: React.FC = () => {
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [selRect, setSelRect] = useState<Rect | null>(null);
  const [finalized, setFinalized] = useState(false);
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);

  // The loaded Image element — only valid after onload fires
  const imgRef = useRef<HTMLImageElement | null>(null);
  const imgLoaded = useRef(false);

  // Drag tracking
  const dragMode = useRef<DragMode>('none');
  const dragStart = useRef({ x: 0, y: 0 });
  const dragOrigRect = useRef<Rect | null>(null);

  // ── Listen for the screenshot data from main ────────────────────────
  useEffect(() => {
    const handler = (dataUrl: string): void => {
      imgLoaded.current = false;
      const img = new Image();
      img.onload = () => {
        imgLoaded.current = true;
        imgRef.current = img;
      };
      img.src = dataUrl;

      setScreenshot(dataUrl);
      setSelRect(null);
      setFinalized(false);
      setCopied(false);
      setSaved(false);
    };
    return window.electronAPI.onScreenshotCaptured(handler);
  }, []);

  const close = useCallback(() => {
    setScreenshot(null);
    setSelRect(null);
    setFinalized(false);
    setCopied(false);
    setSaved(false);
  }, []);

  // ── Crop helper ─────────────────────────────────────────────────────
  const cropToBlob = useCallback(async (): Promise<Blob | null> => {
    const r = selRect;
    if (!r || r.width < 4 || r.height < 4 || !imgLoaded.current || !imgRef.current) return null;

    const img = imgRef.current;
    const scaleX = img.naturalWidth / window.innerWidth;
    const scaleY = img.naturalHeight / window.innerHeight;

    const sx = r.left * scaleX;
    const sy = r.top * scaleY;
    const sw = r.width * scaleX;
    const sh = r.height * scaleY;

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(sw);
    canvas.height = Math.round(sh);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

    return new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'),
    );
  }, [selRect]);

  // ── Copy to clipboard ──────────────────────────────────────────────
  const copyToClipboard = useCallback(async () => {
    try {
      const blob = await cropToBlob();
      if (!blob) return;
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setCopied(true);
      setTimeout(() => close(), 600);
    } catch (err) {
      console.error('Screenshot copy failed', err);
    }
  }, [cropToBlob, close]);

  // ── Download (save via virtual link) ───────────────────────────────
  const downloadImage = useCallback(async () => {
    try {
      const blob = await cropToBlob();
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `screenshot-${Date.now()}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setSaved(true);
      setTimeout(() => close(), 600);
    } catch (err) {
      console.error('Screenshot download failed', err);
    }
  }, [cropToBlob]);

  // ── Keyboard shortcuts ────────────────────────────────────────────
  useEffect(() => {
    if (!screenshot) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { close(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && finalized && selRect) {
        e.preventDefault();
        void copyToClipboard();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [screenshot, finalized, selRect, close, copyToClipboard]);

  // ── Constrain rect inside viewport ────────────────────────────────
  const clampRect = (r: Rect): Rect => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let { left, top, width, height } = r;
    width = Math.max(8, width);
    height = Math.max(8, height);
    left = Math.max(0, Math.min(left, vw - width));
    top = Math.max(0, Math.min(top, vh - height));
    return { left, top, width, height };
  };

  // ── Global mouse move/up for all drag operations ──────────────────
  useEffect(() => {
    if (!screenshot) return;

    const onMove = (e: MouseEvent) => {
      if (dragMode.current === 'none') return;

      const dx = e.clientX - dragStart.current.x;
      const dy = e.clientY - dragStart.current.y;
      const orig = dragOrigRect.current;

      if (dragMode.current === 'selecting') {
        setSelRect({
          left: Math.min(dragStart.current.x, e.clientX),
          top: Math.min(dragStart.current.y, e.clientY),
          width: Math.abs(dx),
          height: Math.abs(dy),
        });
        return;
      }

      if (!orig) return;

      if (dragMode.current === 'moving') {
        setSelRect(clampRect({
          left: orig.left + dx,
          top: orig.top + dy,
          width: orig.width,
          height: orig.height,
        }));
        return;
      }

      // Resize handles
      let { left, top, width, height } = orig;
      const mode = dragMode.current;

      if (mode.includes('e')) {
        width = Math.max(8, orig.width + dx);
      }
      if (mode.includes('w')) {
        const newW = Math.max(8, orig.width - dx);
        left = orig.left + (orig.width - newW);
        width = newW;
      }
      if (mode.includes('s')) {
        height = Math.max(8, orig.height + dy);
      }
      if (mode.includes('n')) {
        const newH = Math.max(8, orig.height - dy);
        top = orig.top + (orig.height - newH);
        height = newH;
      }

      setSelRect({ left, top, width, height });
    };

    const onUp = () => {
      if (dragMode.current === 'selecting') {
        setSelRect(prev => {
          if (!prev || prev.width < 4 || prev.height < 4) return null;
          return prev;
        });
        setFinalized(true);
      }
      dragMode.current = 'none';
      dragOrigRect.current = null;
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [screenshot]);

  // ── Start initial selection ────────────────────────────────────────
  const onBackgroundMouseDown = useCallback((e: React.MouseEvent) => {
    if (finalized) return; // Don't restart selection once finalized
    e.preventDefault();
    dragMode.current = 'selecting';
    dragStart.current = { x: e.clientX, y: e.clientY };
    setSelRect(null);
    setCopied(false);
    setSaved(false);
  }, [finalized]);

  // ── Start moving the selection ─────────────────────────────────────
  const onSelectionMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!selRect) return;
    dragMode.current = 'moving';
    dragStart.current = { x: e.clientX, y: e.clientY };
    dragOrigRect.current = { ...selRect };
  }, [selRect]);

  // ── Start resize from handle ──────────────────────────────────────
  const onHandleMouseDown = useCallback((e: React.MouseEvent, handle: DragMode) => {
    e.preventDefault();
    e.stopPropagation();
    if (!selRect) return;
    dragMode.current = handle;
    dragStart.current = { x: e.clientX, y: e.clientY };
    dragOrigRect.current = { ...selRect };
  }, [selRect]);

  if (!screenshot) return null;

  const renderHandles = () => {
    if (!selRect || !finalized) return null;
    const handles: { mode: DragMode; style: React.CSSProperties }[] = [
      // Corners
      { mode: 'nw', style: { left: -HANDLE_SIZE / 2, top: -HANDLE_SIZE / 2 } },
      { mode: 'ne', style: { right: -HANDLE_SIZE / 2, top: -HANDLE_SIZE / 2 } },
      { mode: 'sw', style: { left: -HANDLE_SIZE / 2, bottom: -HANDLE_SIZE / 2 } },
      { mode: 'se', style: { right: -HANDLE_SIZE / 2, bottom: -HANDLE_SIZE / 2 } },
      // Edges
      { mode: 'n', style: { left: '50%', top: -HANDLE_SIZE / 2, transform: 'translateX(-50%)' } },
      { mode: 's', style: { left: '50%', bottom: -HANDLE_SIZE / 2, transform: 'translateX(-50%)' } },
      { mode: 'w', style: { left: -HANDLE_SIZE / 2, top: '50%', transform: 'translateY(-50%)' } },
      { mode: 'e', style: { right: -HANDLE_SIZE / 2, top: '50%', transform: 'translateY(-50%)' } },
    ];

    return handles.map(({ mode, style }) => (
      <div
        key={mode}
        onMouseDown={(e) => onHandleMouseDown(e, mode)}
        style={{
          position: 'absolute',
          width: HANDLE_SIZE,
          height: HANDLE_SIZE,
          background: '#fff',
          border: '1.5px solid #4a9eff',
          borderRadius: '50%',
          cursor: CURSOR_MAP[mode] || 'default',
          zIndex: 10,
          ...style,
        }}
      />
    ));
  };

  // Dashed border for finalized selection
  const borderStyle = finalized
    ? '2px dashed rgba(255,255,255,0.7)'
    : '1.5px solid #4a9eff';

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 99999,
        cursor: finalized ? 'default' : 'crosshair',
        userSelect: 'none',
      }}
      onMouseDown={onBackgroundMouseDown}
    >
      {/* Full-viewport screenshot image */}
      <img
        src={screenshot}
        alt=""
        draggable={false}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          display: 'block',
          pointerEvents: 'none',
        }}
      />

      {/* Dim overlay — before selection or outside selection */}
      {!selRect && !copied && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.45)',
            pointerEvents: 'none',
          }}
        />
      )}

      {/* Selection rectangle */}
      {selRect && selRect.width > 0 && selRect.height > 0 && (
        <>
          {/* Dim area via box-shadow */}
          <div
            style={{
              position: 'absolute',
              left: selRect.left,
              top: selRect.top,
              width: selRect.width,
              height: selRect.height,
              boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.45)',
              border: borderStyle,
              borderRadius: 2,
              pointerEvents: 'none',
            }}
          />

          {/* Interactive layer for moving + resize handles */}
          {finalized && (
            <div
              onMouseDown={onSelectionMouseDown}
              style={{
                position: 'absolute',
                left: selRect.left,
                top: selRect.top,
                width: selRect.width,
                height: selRect.height,
                cursor: 'move',
                zIndex: 5,
              }}
            >
              {renderHandles()}
            </div>
          )}

          {/* Dimension label */}
          <div
            style={{
              position: 'absolute',
              left: selRect.left,
              top: selRect.top - 28,
              background: 'rgba(0,0,0,0.75)',
              backdropFilter: 'blur(4px)',
              color: '#d4d4d4',
              fontSize: 11,
              fontFamily: 'Inter, system-ui, sans-serif',
              padding: '2px 8px',
              borderRadius: 4,
              pointerEvents: 'none',
              whiteSpace: 'nowrap',
            }}
          >
            {Math.round(selRect.width)} × {Math.round(selRect.height)}
          </div>

          {/* ── Action toolbar (below selection) ── */}
          {finalized && (
            <div
              style={{
                position: 'absolute',
                left: selRect.left + selRect.width / 2,
                top: selRect.top + selRect.height + 16,
                transform: 'translateX(-50%)',
                display: 'flex',
                gap: 8,
                background: 'rgba(22, 22, 26, 0.92)',
                backdropFilter: 'blur(16px)',
                padding: '8px 12px',
                borderRadius: 12,
                boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
                zIndex: 20,
              }}
            >
              {/* Close button */}
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); close(); }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 36,
                  height: 36,
                  borderRadius: 8,
                  border: '1px solid rgba(255,255,255,0.12)',
                  background: 'rgba(255,255,255,0.06)',
                  color: '#aaa',
                  cursor: 'pointer',
                  fontSize: 18,
                  transition: 'all 150ms ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(255,255,255,0.12)';
                  e.currentTarget.style.color = '#fff';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'rgba(255,255,255,0.06)';
                  e.currentTarget.style.color = '#aaa';
                }}
                title="Close (Esc)"
              >
                ✕
              </button>

              {/* Copy button */}
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); void copyToClipboard(); }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '0 16px',
                  height: 36,
                  borderRadius: 8,
                  border: copied ? '1px solid #4ade80' : '1px solid rgba(255,255,255,0.2)',
                  background: copied ? 'rgba(74, 222, 128, 0.15)' : 'rgba(255,255,255,0.08)',
                  color: copied ? '#4ade80' : '#e4e4e4',
                  cursor: 'pointer',
                  fontSize: 13,
                  fontWeight: 500,
                  fontFamily: 'Inter, system-ui, sans-serif',
                  transition: 'all 150ms ease',
                  whiteSpace: 'nowrap',
                }}
                onMouseEnter={(e) => {
                  if (!copied) {
                    e.currentTarget.style.background = 'rgba(255,255,255,0.15)';
                  }
                }}
                onMouseLeave={(e) => {
                  if (!copied) {
                    e.currentTarget.style.background = 'rgba(255,255,255,0.08)';
                  }
                }}
                title="Copy to clipboard (Ctrl+C)"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
                {copied ? 'Copied!' : 'Copy'}
              </button>

              {/* Download button */}
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); void downloadImage(); }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '0 16px',
                  height: 36,
                  borderRadius: 8,
                  border: saved ? '1px solid #2dd4bf' : '1px solid #2dd4bf',
                  background: saved ? 'rgba(45, 212, 191, 0.15)' : 'rgba(45, 212, 191, 0.1)',
                  color: saved ? '#5eead4' : '#2dd4bf',
                  cursor: 'pointer',
                  fontSize: 13,
                  fontWeight: 500,
                  fontFamily: 'Inter, system-ui, sans-serif',
                  transition: 'all 150ms ease',
                  whiteSpace: 'nowrap',
                }}
                onMouseEnter={(e) => {
                  if (!saved) {
                    e.currentTarget.style.background = 'rgba(45, 212, 191, 0.2)';
                  }
                }}
                onMouseLeave={(e) => {
                  if (!saved) {
                    e.currentTarget.style.background = 'rgba(45, 212, 191, 0.1)';
                  }
                }}
                title="Download as PNG"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                {saved ? 'Saved!' : 'Download'}
              </button>
            </div>
          )}
        </>
      )}

      {/* Instruction hint */}
      {!selRect && !finalized && (
        <div
          style={{
            position: 'absolute',
            bottom: 32,
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'rgba(0,0,0,0.7)',
            backdropFilter: 'blur(8px)',
            color: '#aaa',
            fontSize: 12,
            fontFamily: 'Inter, system-ui, sans-serif',
            padding: '6px 16px',
            borderRadius: 6,
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          Drag to select · <span style={{ color: '#d4d4d4' }}>Esc</span> to cancel
        </div>
      )}
    </div>
  );
};
