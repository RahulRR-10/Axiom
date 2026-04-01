import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Full-screen overlay for region-select screenshot.
 *
 * Approach (simplified — no second image copy needed):
 *   • Screenshot image fills the viewport as the background.
 *   • A selection rectangle div uses a massive `box-shadow` to dim
 *     everything outside it, leaving the selected area at full brightness.
 *   • On mouse-up the selected region is cropped via an off-screen canvas
 *     and copied to the clipboard as PNG.
 */

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const ScreenshotOverlay: React.FC = () => {
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [selRect, setSelRect] = useState<Rect | null>(null);
  const [copied, setCopied] = useState(false);

  // The loaded Image element — only valid after onload fires
  const imgRef = useRef<HTMLImageElement | null>(null);
  const imgLoaded = useRef(false);

  // Drag tracking via refs — immune to React async state issues
  const isDragging = useRef(false);
  const startPt = useRef({ x: 0, y: 0 });

  // ── Listen for the screenshot data from main ──────────────────────────
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
      setCopied(false);
    };
    return window.electronAPI.onScreenshotCaptured(handler);
  }, []);

  // ── Esc to cancel ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!screenshot) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setScreenshot(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [screenshot]);

  // ── Mouse handling ────────────────────────────────────────────────────
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    startPt.current = { x: e.clientX, y: e.clientY };
    setSelRect(null);
    setCopied(false);

    const buildRect = (ev: { clientX: number; clientY: number }): Rect => ({
      left: Math.min(startPt.current.x, ev.clientX),
      top: Math.min(startPt.current.y, ev.clientY),
      width: Math.abs(ev.clientX - startPt.current.x),
      height: Math.abs(ev.clientY - startPt.current.y),
    });

    const onMove = (ev: MouseEvent): void => {
      if (!isDragging.current) return;
      setSelRect(buildRect(ev));
    };

    const onUp = async (ev: MouseEvent): Promise<void> => {
      isDragging.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp as EventListener);

      const r = buildRect(ev);

      if (r.width < 4 || r.height < 4 || !imgLoaded.current || !imgRef.current) {
        setScreenshot(null);
        return;
      }

      // capturePage() returns an image at native resolution (CSS px × DPR).
      // We need to map CSS-pixel selection coordinates to image pixels.
      const img = imgRef.current;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const scaleX = img.naturalWidth / vw;
      const scaleY = img.naturalHeight / vh;

      const sx = r.left * scaleX;
      const sy = r.top * scaleY;
      const sw = r.width * scaleX;
      const sh = r.height * scaleY;

      const canvas = document.createElement('canvas');
      canvas.width = Math.round(sw);
      canvas.height = Math.round(sh);
      const ctx = canvas.getContext('2d');
      if (!ctx) { setScreenshot(null); return; }

      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

      try {
        const blob = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'),
        );
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        setCopied(true);
        setTimeout(() => setScreenshot(null), 600);
      } catch (err) {
        console.error('Screenshot copy failed', err);
        setScreenshot(null);
      }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp as EventListener);
  }, []);

  if (!screenshot) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 99999,
        cursor: 'crosshair',
        userSelect: 'none',
      }}
      onMouseDown={onMouseDown}
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

      {/* Before any selection: dim the whole viewport */}
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

      {/* Selection rectangle — box-shadow dims everything outside */}
      {selRect && selRect.width > 0 && selRect.height > 0 && (
        <>
          <div
            style={{
              position: 'absolute',
              left: selRect.left,
              top: selRect.top,
              width: selRect.width,
              height: selRect.height,
              boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.45)',
              border: '1.5px solid #4a9eff',
              borderRadius: 2,
              pointerEvents: 'none',
            }}
          />

          {/* Dimension label */}
          <div
            style={{
              position: 'absolute',
              left: selRect.left,
              top: selRect.top + selRect.height + 8,
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
        </>
      )}

      {/* "Copied ✓" toast */}
      {copied && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            background: 'rgba(0,0,0,0.8)',
            backdropFilter: 'blur(12px)',
            color: '#4ade80',
            fontSize: 16,
            fontWeight: 600,
            fontFamily: 'Inter, system-ui, sans-serif',
            padding: '12px 28px',
            borderRadius: 10,
            boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
            pointerEvents: 'none',
          }}
        >
          Copied to clipboard ✓
        </div>
      )}

      {/* Instruction hint */}
      {!selRect && !copied && (
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
