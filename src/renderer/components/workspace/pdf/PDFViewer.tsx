import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { Annotation } from '../../../../shared/types';
import type { PDFTool } from './PDFToolbar';
import { PDFToolbar } from './PDFToolbar';
import { FloatingActionBar } from '../FloatingActionBar';
import { AnnotationLayer } from './AnnotationLayer';
// Text layer CSS — webpack style-loader injects this at runtime
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('../../../styles/pdf-text-layer.css');

/* ─── pdf.js setup ─────────────────────────────────────────────────────────── */
// pdfjs-dist v5 requires a fully-qualified URL for the worker — a bare module
// specifier like 'pdf.worker.min.mjs' fails with "Failed to resolve module
// specifier". new URL() resolves relative to window.location.href which is:
//   dev:  http://localhost:9000/pdf.worker.min.mjs  (webpack HMR server)
//   prod: file:///...app.asar/.../pdf.worker.min.mjs
// CopyPlugin copies the worker file to the webpack output root.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfjsLib = require('pdfjs-dist') as typeof import('pdfjs-dist');
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdf.worker.min.mjs',
  window.location.href,
).href;

const PAGE_GAP    = 16; // px between pages
const BUFFER_PAGES = 2; // render this many pages outside viewport

/* ─── Types ─────────────────────────────────────────────────────────────────── */
type PageSize = { width: number; height: number };

type Props = {
  filePath:  string;
  fileId?:   string;
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
  onVisible,
}: {
  pdf:              PDFDocumentProxy;
  pageNum:          number;
  scale:            number;
  cssWidth:         number;
  cssHeight:        number;
  activeTool:       PDFTool;
  highlightColor:   string;
  fileId:           string;
  vaultPath:        string;
  annotations:      Annotation[];
  onAnnotationSaved: () => void;
  onVisible:        (pageNum: number) => void;
}) {
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const wrapRef      = useRef<HTMLDivElement>(null);
  const rendered     = useRef(false);

  // IntersectionObserver to report visibility
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      entries => {
        if (entries[0].isIntersecting) onVisible(pageNum);
      },
      { threshold: 0.3 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [pageNum, onVisible]);

  // Render canvas + text layer
  useEffect(() => {
    if (!canvasRef.current || !textLayerRef.current) return;
    rendered.current = false;
    let cancelled = false;

    (async () => {
      const page = await pdf.getPage(pageNum);
      const dpr  = window.devicePixelRatio || 1;

      // CSS-scale viewport — text layer positioning and canvas CSS size
      const cssViewport    = page.getViewport({ scale });
      // Hi-DPI viewport — canvas pixel buffer only
      const canvasViewport = page.getViewport({ scale: scale * dpr });

      // ── Canvas ────────────────────────────────────────────────────────────
      const canvas = canvasRef.current!;
      canvas.width  = Math.floor(canvasViewport.width);
      canvas.height = Math.floor(canvasViewport.height);
      canvas.style.width  = `${Math.floor(cssViewport.width)}px`;
      canvas.style.height = `${Math.floor(cssViewport.height)}px`;
      await page.render({ canvas, viewport: canvasViewport }).promise;

      if (cancelled) return;

      // ── Text layer ────────────────────────────────────────────────────────
      // Populates textLayerDiv with transparent but DOM-selectable <span>s,
      // enabling native text selection (and therefore highlight tool capture).
      //
      // pdfjs v5 TextLayer internally does:
      //   this.#scale = viewport.scale * devicePixelRatio
      // and uses that to measure text widths via a hidden canvas.
      // setLayerDimensions() sizes the container with:
      //   width: calc(var(--total-scale-factor) * <pageWidth>px)
      // So we must provide --total-scale-factor on the container equal to
      // the CSS-space scale (viewport.scale) so the div is the right size.
      //
      // The viewport we pass should be scale=1 (unit-scale) so that internal
      // #scale = 1 * DPR and positions are in page-coordinate percentages.
      // We then use --total-scale-factor to scale the container to CSS size.
      const textLayerDiv = textLayerRef.current!;
      textLayerDiv.innerHTML = '';

      // Unit-scale viewport — pdfjs positions spans via % of page dimensions
      const unitViewport = page.getViewport({ scale: 1 });

      // Tell the container its CSS size via --total-scale-factor
      textLayerDiv.style.setProperty('--total-scale-factor', `${scale}`);
      // Also set scale-round helpers (used by CSS round() when supported)
      const dprForRound = window.devicePixelRatio || 1;
      textLayerDiv.style.setProperty('--scale-round-x', `${1 / (scale * dprForRound)}px`);
      textLayerDiv.style.setProperty('--scale-round-y', `${1 / (scale * dprForRound)}px`);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tl = new (pdfjsLib as any).TextLayer({
        textContentSource: await page.getTextContent(),
        container:         textLayerDiv,
        viewport:          unitViewport,
      });
      await tl.render();

      if (!cancelled) rendered.current = true;
    })().catch(console.error);

    return () => { cancelled = true; };
  }, [pdf, pageNum, scale]);

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
        overflow:     'hidden',
        cursor:       activeTool === 'highlight' ? 'text'
                    : activeTool === 'sticky' ? 'crosshair'
                    : activeTool === 'draw' ? 'crosshair'
                    : 'default',
      }}
    >
      {/* Pixel-perfect canvas render of the PDF page */}
      <canvas
        ref={canvasRef}
        style={{ position: 'absolute', top: 0, left: 0, zIndex: 1, pointerEvents: 'none' }}
      />
      {/* Transparent selectable text spans — enables highlight + clipboard */}
      <div
        ref={textLayerRef}
        className="textLayer"
        style={{ zIndex: 2, pointerEvents: 'auto', userSelect: 'text', WebkitUserSelect: 'text' } as React.CSSProperties}
      />
      {/* Highlight/sticky overlays — pointer-events: none so text stays selectable */}
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
      />
    </div>
  );
});

/* ─── PDFViewer ─────────────────────────────────────────────────────────────── */
export const PDFViewer: React.FC<Props> = ({ filePath, fileId = '', vaultPath = null }) => {
  const [pdf,          setPdf]          = useState<PDFDocumentProxy | null>(null);
  const [numPages,     setNumPages]     = useState(0);
  const [pageSizes,    setPageSizes]    = useState<PageSize[]>([]);
  const [currentPage,  setCurrentPage]  = useState(1);
  const [zoom,         setZoom]         = useState(1.0);
  const [activeTool,   setActiveTool]   = useState<PDFTool>('none');
  const [hlColor,      setHlColor]      = useState('#fde68a');
  const [annotations,  setAnnotations]  = useState<Annotation[]>([]);
  const [error,        setError]        = useState<string | null>(null);
  const [loading,      setLoading]      = useState(true);

  const containerRef   = useRef<HTMLDivElement>(null);
  const scrollRef      = useRef<HTMLDivElement>(null);
  const visiblePages   = useRef(new Set<number>());

  // ── Base scale: fit page to container width ─────────────────────────────
  const baseScaleRef = useRef(1);

  const computeScale = (baseScale: number) => baseScale * zoom;

  // ── Load PDF ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!filePath) return;
    setLoading(true);
    setError(null);
    setPdf(null);
    setNumPages(0);
    setPageSizes([]);
    setCurrentPage(1);
    visiblePages.current.clear();

    (async () => {
      // readFile already returns Uint8Array (converted in preload)
      const data        = await window.electronAPI.readFile(filePath);
      const loadingTask = pdfjsLib.getDocument({ data });
      const doc     = await loadingTask.promise;

      const n = doc.numPages;
      setNumPages(n);
      setPdf(doc);

      // Compute page sizes (use page 1 as base for container-width fitting)
      const page1 = await doc.getPage(1);
      const vp1   = page1.getViewport({ scale: 1 });
      const containerW = scrollRef.current?.clientWidth ?? 800;
      const baseScale  = (containerW - 32) / vp1.width; // 16px padding each side
      baseScaleRef.current = baseScale;

      const sizes: PageSize[] = [];
      for (let i = 1; i <= n; i++) {
        const p  = await doc.getPage(i);
        const vp = p.getViewport({ scale: baseScale });
        sizes.push({ width: Math.floor(vp.width), height: Math.floor(vp.height) });
      }
      setPageSizes(sizes);
      setLoading(false);
    })().catch(err => {
      console.error('[PDFViewer] load error', err);
      setError(String(err));
      setLoading(false);
    });
  }, [filePath]);

  // ── Load annotations ──────────────────────────────────────────────────────
  const loadAnnotations = useCallback(() => {
    if (!fileId || !vaultPath) return;
    window.electronAPI
      .loadAnnotations(vaultPath, fileId)
      .then(setAnnotations)
      .catch(console.error);
  }, [fileId, vaultPath]);

  useEffect(() => { loadAnnotations(); }, [loadAnnotations]);

  // ── Visible page tracker ──────────────────────────────────────────────────
  const handlePageVisible = useCallback((pageNum: number) => {
    visiblePages.current.add(pageNum);
    // Report the lowest visible page as currentPage
    const min = Math.min(...Array.from(visiblePages.current));
    setCurrentPage(min);
  }, []);

  // ── Virtualized page list: determine which pages to actually render ───────
  // Simplified: render all pages for now but with minimal canvases via
  // a cascading IntersectionObserver render. The placeholder divs keep
  // the scroll height correct without mounting expensive canvas elements.
  const renderList = () => {
    if (!pdf || !pageSizes.length) return null;
    const scale = computeScale(baseScaleRef.current);

    return Array.from({ length: numPages }, (_, i) => {
      const pageNum = i + 1;
      const size    = pageSizes[i] ?? pageSizes[0];
      if (!size) return null;

      const cssW = Math.floor(size.width  * zoom);
      const cssH = Math.floor(size.height * zoom);

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
          fileId={fileId}
          vaultPath={vaultPath ?? ''}
          annotations={annotations}
          onAnnotationSaved={loadAnnotations}
          onVisible={handlePageVisible}
        />
      );
    });
  };

  return (
    <div
      ref={containerRef}
      style={{
        height:       '100%',
        width:        '100%',
        display:      'flex',
        flexDirection:'column',
        overflow:     'hidden',
        background:   '#141414',
      }}
    >
      {/* Toolbar */}
      <PDFToolbar
        activeTool={activeTool}
        onToolChange={setActiveTool}
        highlightColor={hlColor}
        onColorChange={setHlColor}
        zoomLevel={zoom}
        onZoomChange={setZoom}
      />

      {/* Scroll area */}
      <div
        ref={scrollRef}
        style={{
          flex:        1,
          overflowY:  'auto',
          overflowX:  'auto',
          background: '#141414',
          position:   'relative',
        }}
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
          <div
            style={{
              display:        'flex',
              flexDirection:  'column',
              alignItems:     'center',
              padding:        '16px',
              minHeight:      '100%',
            }}
          >
            {renderList()}
          </div>
        )}

        {/* Floating action bar anchored to the scroll area */}
        {!loading && !error && (
          <FloatingActionBar
            containerRef={scrollRef as React.RefObject<HTMLElement>}
            currentPage={currentPage}
            filePath={filePath}
          />
        )}
      </div>

      {/* Page indicator */}
      {!loading && !error && numPages > 0 && (
        <div
          style={{
            height:       '28px',
            background:   '#1a1a1a',
            borderTop:    '1px solid #2a2a2a',
            flexShrink:   0,
          }}
          className="flex items-center justify-center"
        >
          <span className="text-[10px] text-[#6e6e6e] select-none">
            Page {currentPage} / {numPages}
          </span>
        </div>
      )}
    </div>
  );
};
