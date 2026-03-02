import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { PDFDocument, rgb } from 'pdf-lib';
import type { Annotation, HighlightAnnotation, DrawAnnotation } from '../../../../shared/types';
import type { PDFTool } from './PDFToolbar';
import { PDFToolbar } from './PDFToolbar';
import { FloatingActionBar } from '../FloatingActionBar';
import { AnnotationLayer } from './AnnotationLayer';
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('../../../styles/pdf-text-layer.css');

/* ─── pdf.js setup ─────────────────────────────────────────────────────────── */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfjsLib = require('pdfjs-dist') as typeof import('pdfjs-dist');
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdf.worker.min.mjs',
  window.location.href,
).href;

const PAGE_GAP    = 16;
const BUFFER_PX   = 1200; // render pages within this many pixels of the viewport

/* ─── PDF document cache ───────────────────────────────────────────────────── */
const pdfCache = new Map<string, PDFDocumentProxy>();

/* ─── Types ─────────────────────────────────────────────────────────────────── */
type PageMeta = { width: number; height: number };

type Props = {
  filePath:   string;
  fileId?:    string;
  vaultPath?: string | null;
};

/* ─── Single page renderer ─────────────────────────────────────────────────── */
const PDFPage = React.memo(function PDFPage({
  pdf,
  pageNum,
  scale,
  cssWidth,
  cssHeight,
  activeTool,
  highlightColor,
  fileId,
  vaultPath,
  annotations,
  onAnnotationSaved,
  fontSize: propFontSize,
  textColor: propTextColor,
}: {
  pdf:               PDFDocumentProxy;
  pageNum:           number;
  scale:             number;
  cssWidth:          number;
  cssHeight:         number;
  activeTool:        PDFTool;
  highlightColor:    string;
  fileId:            string;
  vaultPath:         string;
  annotations:       Annotation[];
  onAnnotationSaved: () => void;
  fontSize:          number;
  textColor:         string;
}) {
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const wrapRef      = useRef<HTMLDivElement>(null);

  /* Render canvas + text layer */
  useEffect(() => {
    const canvas       = canvasRef.current;
    const textLayerDiv = textLayerRef.current;
    if (!canvas || !textLayerDiv) return;

    let cancelled = false;

    (async () => {
      const page = await pdf.getPage(pageNum);
      if (cancelled) return;

      const dpr            = window.devicePixelRatio || 1;
      const cssViewport    = page.getViewport({ scale });
      const canvasViewport = page.getViewport({ scale: scale * dpr });

      canvas.width          = Math.floor(canvasViewport.width);
      canvas.height         = Math.floor(canvasViewport.height);
      canvas.style.width    = `${cssWidth}px`;
      canvas.style.height   = `${cssHeight}px`;

      await page.render({ canvas, viewport: canvasViewport }).promise;
      if (cancelled) return;

      textLayerDiv.innerHTML = '';
      textLayerDiv.style.setProperty('--scale-factor', `${scale}`);
      textLayerDiv.style.setProperty('--total-scale-factor', `${scale}`);
      textLayerDiv.style.setProperty('--scale-round-x', `${1 / (scale * dpr)}px`);
      textLayerDiv.style.setProperty('--scale-round-y', `${1 / (scale * dpr)}px`);

      const textContent = await page.getTextContent({
        includeMarkedContent: true,
        disableNormalization: true,
      });
      if (cancelled) return;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tl = new (pdfjsLib as any).TextLayer({
        textContentSource: textContent,
        container:         textLayerDiv,
        viewport:          cssViewport,
      });
      await tl.render();
      if (cancelled) return;

      // Force Chromium to register hit-test regions
      const parent = textLayerDiv.parentNode;
      const next   = textLayerDiv.nextSibling;
      if (parent) {
        parent.removeChild(textLayerDiv);
        void (parent as HTMLElement).offsetHeight;
        parent.insertBefore(textLayerDiv, next);
        void textLayerDiv.offsetHeight;
      }
    })().catch(console.error);

    return () => { cancelled = true; };
  }, [pdf, pageNum, scale, cssWidth, cssHeight]);

  return (
    <div
      ref={wrapRef}
      style={{
        position:     'relative',
        width:        cssWidth,
        height:       cssHeight,
        flexShrink:   0,
        marginBottom: PAGE_GAP,
        boxShadow:    '0 2px 8px rgba(0,0,0,0.5)',
        background:   '#ffffff',
        cursor:       activeTool === 'sticky'  ? 'crosshair'
                    : activeTool === 'draw'    ? 'crosshair'
                    : activeTool === 'image'   ? 'crosshair'
                    : activeTool === 'eraser'  ? 'crosshair'
                    : 'text',
      }}
    >
      <canvas
        ref={canvasRef}
        style={{ display: 'block', position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}
      />
      <div ref={textLayerRef} className="textLayer" />
      <AnnotationLayer
        activeTool={activeTool}
        highlightColor={highlightColor}
        fileId={fileId}
        page={pageNum}
        vaultPath={vaultPath}
        cssWidth={cssWidth}
        cssHeight={cssHeight}
        wrapperRef={wrapRef}
        annotations={annotations.filter(a => a.page === pageNum)}
        onAnnotationSaved={onAnnotationSaved}
        fontSize={propFontSize}
        textColor={propTextColor}
      />
    </div>
  );
});

/* ─── Placeholder for off-screen pages (keeps scroll height correct) ──────── */
const PagePlaceholder = React.memo(function PagePlaceholder({
  cssWidth,
  cssHeight,
}: {
  cssWidth:  number;
  cssHeight: number;
}) {
  return (
    <div
      style={{
        width:        cssWidth,
        height:       cssHeight,
        flexShrink:   0,
        marginBottom: PAGE_GAP,
        background:   '#1e1e1e',
        borderRadius: 2,
      }}
    />
  );
});

/* ═══════════════════════════════════════════════════════════════════════════════
   PDFViewer — main component
═══════════════════════════════════════════════════════════════════════════════ */
export const PDFViewer: React.FC<Props> = ({ filePath, fileId = '', vaultPath = null }) => {
  const effectiveFileId = fileId || filePath;

  const [pdf,         setPdf]         = useState<PDFDocumentProxy | null>(null);
  const [numPages,    setNumPages]    = useState(0);
  const [pageMeta,    setPageMeta]    = useState<PageMeta | null>(null); // uniform page size
  const [currentPage, setCurrentPage] = useState(1);
  const [zoom,        setZoom]        = useState(1.0);
  const [activeTool,  setActiveTool]  = useState<PDFTool>('none');
  const [hlColor,     setHlColor]     = useState('#fde68a');
  const [fontSize,    setFontSize]    = useState(14);
  const [textColor,   setTextColor]   = useState('#ffffff');
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [error,       setError]       = useState<string | null>(null);
  const [loading,     setLoading]     = useState(true);
  const [saving,      setSaving]      = useState(false);
  const [visibleRange, setVisibleRange] = useState<[number, number]>([1, 3]);

  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef    = useRef<HTMLDivElement>(null);
  const visiblePages = useRef(new Set<number>());
  const baseScaleRef = useRef(1);

  /* ── Load PDF (fast — only reads page 1 for sizing) ──────────────────────── */
  useEffect(() => {
    if (!filePath) return;
    setLoading(true);
    setError(null);
    setPdf(null);
    setNumPages(0);
    setPageMeta(null);
    setCurrentPage(1);
    visiblePages.current.clear();

    (async () => {
      // Check cache first
      let doc = pdfCache.get(filePath);
      if (!doc) {
        const data = await window.electronAPI.readFile(filePath);
        doc = await pdfjsLib.getDocument({ data }).promise;
        pdfCache.set(filePath, doc);
      }

      const n = doc.numPages;
      setNumPages(n);
      setPdf(doc);

      // Use page 1 dimensions for all pages (fast — avoids N sequential getPage calls)
      const page1      = await doc.getPage(1);
      const vp1        = page1.getViewport({ scale: 1 });
      const containerW = scrollRef.current?.clientWidth ?? 800;
      const baseScale  = (containerW - 32) / vp1.width;
      baseScaleRef.current = baseScale;

      const vp = page1.getViewport({ scale: baseScale });
      setPageMeta({ width: Math.floor(vp.width), height: Math.floor(vp.height) });
      setLoading(false);
    })().catch(err => {
      console.error('[PDFViewer] load error', err);
      setError(String(err));
      setLoading(false);
    });
  }, [filePath]);

  /* ── Annotations ─────────────────────────────────────────────────────────── */
  const loadAnnotations = useCallback(() => {
    if (!vaultPath) return;
    window.electronAPI.loadAnnotations(vaultPath, effectiveFileId).then(setAnnotations).catch(console.error);
  }, [effectiveFileId, vaultPath]);
  useEffect(() => { loadAnnotations(); }, [loadAnnotations]);

  /* ── Save PDF ────────────────────────────────────────────────────────────── */
  const savePdf = useCallback(async () => {
    if (!filePath || saving) return;
    setSaving(true);
    try {
      const fileBytes = await window.electronAPI.readFile(filePath);
      const pdfDoc    = await PDFDocument.load(fileBytes);
      const pages     = pdfDoc.getPages();

      for (const ann of annotations) {
        const pageIdx = ann.page - 1;
        if (pageIdx < 0 || pageIdx >= pages.length) continue;
        const pdfPage = pages[pageIdx];
        const { width: pw, height: ph } = pdfPage.getSize();

        if (ann.type === 'highlight') {
          const hl = ann as HighlightAnnotation;
          const hex = hl.color.replace('#', '');
          const cr = parseInt(hex.substring(0, 2), 16) / 255;
          const cg = parseInt(hex.substring(2, 4), 16) / 255;
          const cb = parseInt(hex.substring(4, 6), 16) / 255;
          for (const r of hl.rects) {
            pdfPage.drawRectangle({
              x: r.x * pw, y: (1 - r.y) * ph - r.h * ph,
              width: r.w * pw, height: r.h * ph,
              color: rgb(cr, cg, cb), opacity: 0.35,
            });
          }
        } else if (ann.type === 'draw') {
          const dr = ann as DrawAnnotation;
          const hex = dr.color.replace('#', '');
          const cr = parseInt(hex.substring(0, 2), 16) / 255;
          const cg = parseInt(hex.substring(2, 4), 16) / 255;
          const cb = parseInt(hex.substring(4, 6), 16) / 255;
          for (let i = 0; i < dr.points.length - 1; i++) {
            const p1 = dr.points[i], p2 = dr.points[i + 1];
            pdfPage.drawLine({
              start: { x: p1.x * pw, y: (1 - p1.y) * ph },
              end:   { x: p2.x * pw, y: (1 - p2.y) * ph },
              thickness: dr.strokeWidth, color: rgb(cr, cg, cb),
            });
          }
        }
      }

      const savedBytes = await pdfDoc.save();
      // Invalidate cache since file changed
      pdfCache.delete(filePath);
      await window.electronAPI.writeFile(filePath, new Uint8Array(savedBytes));
    } catch (err) {
      console.error('[PDFViewer] Save failed', err);
    } finally {
      setSaving(false);
    }
  }, [filePath, annotations, saving]);

  /* ── Scroll-based virtualization + page tracking ──────────────────────────── */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !pageMeta) return;

    const computeRange = () => {
      const scrollTop    = el.scrollTop;
      const viewportH    = el.clientHeight;
      const pageH        = Math.floor(pageMeta.height * zoom) + PAGE_GAP;
      if (pageH <= 0) return;

      // Current page = which page is at the center of the viewport
      const centerY      = scrollTop + viewportH / 2;
      const centerPage   = Math.max(1, Math.min(numPages, Math.ceil(centerY / pageH)));
      setCurrentPage(centerPage);

      const firstVisible = Math.max(1, Math.floor((scrollTop - BUFFER_PX) / pageH) + 1);
      const lastVisible  = Math.min(numPages, Math.ceil((scrollTop + viewportH + BUFFER_PX) / pageH));
      setVisibleRange([firstVisible, lastVisible]);
    };

    computeRange();
    el.addEventListener('scroll', computeRange, { passive: true });
    return () => el.removeEventListener('scroll', computeRange);
  }, [pageMeta, zoom, numPages]);

  /* ── Build page list with virtualization ──────────────────────────────────── */
  const pageList = useMemo(() => {
    if (!pdf || !pageMeta) return null;
    const scale = baseScaleRef.current * zoom;
    const cssW  = Math.floor(pageMeta.width  * zoom);
    const cssH  = Math.floor(pageMeta.height * zoom);
    const [lo, hi] = visibleRange;

    return Array.from({ length: numPages }, (_, i) => {
      const pageNum = i + 1;

      // Only render pages near the viewport; placeholders for the rest
      if (pageNum < lo || pageNum > hi) {
        return <PagePlaceholder key={`ph-${pageNum}`} cssWidth={cssW} cssHeight={cssH} />;
      }

      return (
        <PDFPage
          key={`${filePath}-${pageNum}`}
          pdf={pdf}
          pageNum={pageNum}
          scale={scale}
          cssWidth={cssW}
          cssHeight={cssH}
          activeTool={activeTool}
          highlightColor={hlColor}
          fileId={effectiveFileId}
          vaultPath={vaultPath ?? ''}
          annotations={annotations}
          onAnnotationSaved={loadAnnotations}
          fontSize={fontSize}
          textColor={textColor}
        />
      );
    });
  }, [pdf, pageMeta, zoom, numPages, visibleRange, filePath, activeTool, hlColor, effectiveFileId, vaultPath, annotations, loadAnnotations]);

  /* ── Render ──────────────────────────────────────────────────────────────── */
  return (
    <div
      ref={containerRef}
      style={{ height: '100%', width: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#141414' }}
    >
      <PDFToolbar
        activeTool={activeTool}
        onToolChange={setActiveTool}
        highlightColor={hlColor}
        onColorChange={setHlColor}
        zoomLevel={zoom}
        onZoomChange={setZoom}
        onSave={savePdf}
        saving={saving}
        currentPage={currentPage}
        numPages={numPages}
        fontSize={fontSize}
        onFontSizeChange={setFontSize}
        textColor={textColor}
        onTextColorChange={setTextColor}
      />

      <div
        ref={scrollRef}
        style={{ flex: 1, overflowY: 'auto', overflowX: 'auto', background: '#141414', position: 'relative' }}
      >
        {loading && (
          <div className="flex items-center justify-center h-full">
            <div className="text-[#6e6e6e] text-sm animate-pulse">Loading PDF…</div>
          </div>
        )}
        {error && (
          <div className="flex items-center justify-center h-full">
            <div className="text-red-400 text-sm max-w-xs text-center">
              Failed to load PDF:<br />
              <span className="text-[#8a8a8a] text-xs">{error}</span>
            </div>
          </div>
        )}
        {!loading && !error && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '16px', minHeight: '100%' }}>
            {pageList}
          </div>
        )}
        {!loading && !error && (
          <FloatingActionBar
            containerRef={scrollRef as React.RefObject<HTMLElement>}
            currentPage={currentPage}
            filePath={filePath}
          />
        )}
      </div>
    </div>
  );
};
