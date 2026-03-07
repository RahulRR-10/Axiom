import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { PDFDocument, rgb } from "pdf-lib";
import type {
  Annotation,
  HighlightAnnotation,
  DrawAnnotation,
} from "../../../../shared/types";
import type { PDFTool } from "./PDFToolbar";
import { PDFToolbar } from "./PDFToolbar";
import { FloatingActionBar } from "../FloatingActionBar";
import { AnnotationLayer } from "./AnnotationLayer";
// eslint-disable-next-line @typescript-eslint/no-require-imports
require("../../../styles/pdf-text-layer.css");

/* ─── pdf.js setup ─────────────────────────────────────────────────────────── */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfjsLib = require("pdfjs-dist") as typeof import("pdfjs-dist");
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdf.worker.min.mjs",
  window.location.href,
).href;

const PAGE_GAP = 16;
const BUFFER_PX = 1200; // render pages within this many pixels of the viewport

/* ─── PDF document cache ───────────────────────────────────────────────────── */
const pdfCache = new Map<string, PDFDocumentProxy>();

/* ─── Types ─────────────────────────────────────────────────────────────────── */
type PageMeta = { width: number; height: number };

type Props = {
  filePath: string;
  fileId?: string;
  vaultPath?: string | null;
  /** If set, scroll to this page after the PDF loads */
  initialPage?: number;
  /** Increment to force re-scroll to the same page */
  scrollNonce?: number;
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
  onAnnotationCreated,
  onAnnotationDeleted,
  onAnnotationUpdated,
  fontSize: propFontSize,
  textColor: propTextColor,
  zoom: propZoom,
  renderNonce: _renderNonce,
}: {
  pdf: PDFDocumentProxy;
  pageNum: number;
  scale: number;
  cssWidth: number;
  cssHeight: number;
  activeTool: PDFTool;
  highlightColor: string;
  fileId: string;
  vaultPath: string;
  annotations: Annotation[];
  onAnnotationCreated: (ann: Annotation) => void;
  onAnnotationDeleted: (annId: string) => void;
  onAnnotationUpdated: (ann: Annotation) => void;
  fontSize: number;
  textColor: string;
  zoom: number;
  renderNonce: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const cleanupSelectionRef = useRef<{
    mousedown: ((e: MouseEvent) => void) | null;
    mouseup: (() => void) | null;
    mousemove: ((e: MouseEvent) => void) | null;
    selectstart: ((e: Event) => void) | null;
    div: HTMLDivElement | null;
  }>({
    mousedown: null,
    mouseup: null,
    mousemove: null,
    selectstart: null,
    div: null,
  }).current;

  /* Scale existing canvas content before paint so there is no blank/flash frame
     while the async re-render is in flight (e.g. during zoom). */
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const prevCssW = parseFloat(canvas.style.width || "0");
    const prevCssH = parseFloat(canvas.style.height || "0");
    if (
      prevCssW > 0 &&
      prevCssH > 0 &&
      canvas.width > 0 &&
      (prevCssW !== cssWidth || prevCssH !== cssHeight)
    ) {
      canvas.style.transformOrigin = "top left";
      canvas.style.transform = `scale(${cssWidth / prevCssW}, ${cssHeight / prevCssH})`;
    }
  }, [cssWidth, cssHeight]);

  /* Render canvas + text layer */
  useEffect(() => {
    const canvas = canvasRef.current;
    const textLayerDiv = textLayerRef.current;
    if (!canvas || !textLayerDiv) return;

    let cancelled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let renderTask: any = null;

    (async () => {
      const page = await pdf.getPage(pageNum);
      if (cancelled) {
        page.cleanup();
        return;
      }

      const dpr = window.devicePixelRatio || 1;
      const cssViewport = page.getViewport({ scale });
      const canvasViewport = page.getViewport({ scale: scale * dpr });

      // Render into an offscreen canvas so the visible canvas is never blank.
      const offscreen = document.createElement("canvas");
      offscreen.width = Math.floor(canvasViewport.width);
      offscreen.height = Math.floor(canvasViewport.height);
      const offCtx = offscreen.getContext("2d");
      if (!offCtx || cancelled) {
        page.cleanup();
        return;
      }

      const task = page.render({
        canvas: offscreen,
        canvasContext: offCtx,
        viewport: canvasViewport,
      });
      renderTask = task;
      try {
        await task.promise;
      } catch (err: any) {
        // RenderingCancelledException is expected — not a real error
        if (err?.name !== "RenderingCancelledException") console.error(err);
        page.cleanup();
        return;
      }
      if (cancelled) {
        page.cleanup();
        return;
      }

      // Atomically copy the offscreen render to the visible canvas.
      // Resizing canvas.width/height auto-clears it, but we immediately
      // draw the finished offscreen content so there is no blank frame.
      canvas.width = offscreen.width;
      canvas.height = offscreen.height;
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;
      canvas.style.transform = "";
      canvas.style.transformOrigin = "";

      const ctx = canvas.getContext("2d");
      if (!ctx || cancelled) {
        page.cleanup();
        return;
      }
      ctx.drawImage(offscreen, 0, 0);

      textLayerDiv.innerHTML = "";
      textLayerDiv.style.setProperty("--scale-factor", `${scale}`);
      textLayerDiv.style.setProperty("--total-scale-factor", `${scale}`);
      textLayerDiv.style.setProperty(
        "--scale-round-x",
        `${1 / (scale * dpr)}px`,
      );
      textLayerDiv.style.setProperty(
        "--scale-round-y",
        `${1 / (scale * dpr)}px`,
      );

      const textContent = await page.getTextContent({
        includeMarkedContent: true,
        disableNormalization: true,
      });
      if (cancelled) {
        page.cleanup();
        return;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tl = new (pdfjsLib as any).TextLayer({
        textContentSource: textContent,
        container: textLayerDiv,
        viewport: cssViewport,
      });
      await tl.render();
      if (cancelled) {
        page.cleanup();
        return;
      }

      /* ── Manual drag selection ─────────────────────────────────────────────
         Native browser selection in pdf.js text layers tends to jump through
         inter-line gaps. We block native drag-selection and manually update
         the Selection range only when the pointer is inside strict text bands.
      ──────────────────────────────────────────────────────────────────── */

      let dragSelecting = false;
      let anchorNode: Node | null = null;
      let anchorOffset = 0;
      let lastAppliedEndNode: Node | null = null;
      let lastAppliedEndOffset = -1;
      let lastPointerX = -1;
      let lastPointerY = -1;

      type HitBand = { left: number; top: number; right: number; bottom: number };
      const strictBandCache = new WeakMap<HTMLElement, HitBand[]>();
      const looseBandCache = new WeakMap<HTMLElement, HitBand[]>();

      const onSelectStart = (evt: Event) => {
        evt.preventDefault();
      };
      textLayerDiv.addEventListener("selectstart", onSelectStart);

      const getSelectableSpan = (node: Node | null): HTMLElement | null => {
        if (!node) return null;
        const el =
          node.nodeType === Node.TEXT_NODE
            ? node.parentElement
            : (node as HTMLElement | null);
        if (!el) return null;

        const span = el.closest("span");
        if (!span || !textLayerDiv.contains(span)) return null;
        if (span.getAttribute("role") === "img") return null;
        return span;
      };

      const pointInsideRect = (
        clientX: number,
        clientY: number,
        rect: HitBand,
      ): boolean => {
        return (
          clientX >= rect.left &&
          clientX <= rect.right &&
          clientY >= rect.top &&
          clientY <= rect.bottom
        );
      };

      const getSpanHitBands = (span: HTMLElement, strict: boolean): HitBand[] => {
        const cache = strict ? strictBandCache : looseBandCache;
        const cached = cache.get(span);
        if (cached) return cached;

        const bands: HitBand[] = [];
        const rects = span.getClientRects();
        for (const rect of rects) {
          const maxInset = Math.max(0, rect.height / 2 - 1);
          const verticalInset = strict
            ? Math.min(Math.max(rect.height * 0.32, 1.5), maxInset)
            : Math.min(Math.max(rect.height * 0.02, 0), maxInset);
          const horizontalInset = strict
            ? Math.min(Math.max(rect.width * 0.005, 0), 0.5)
            : 0;

          const left = rect.left + horizontalInset;
          const top = rect.top + verticalInset;
          const right = rect.right - horizontalInset;
          const bottom = rect.bottom - verticalInset;

          if (right > left && bottom > top) {
            bands.push({ left, top, right, bottom });
          }
        }

        cache.set(span, bands);
        return bands;
      };

      const isPointInsideSpanBand = (
        span: HTMLElement,
        clientX: number,
        clientY: number,
        strict: boolean,
      ): boolean => {
        const hitBands = getSpanHitBands(span, strict);
        for (const hitBand of hitBands) {
          if (pointInsideRect(clientX, clientY, hitBand)) {
            return true;
          }
        }

        return false;
      };

      const getCaretRangeFromPoint = (
        clientX: number,
        clientY: number,
      ): Range | null => {
        const docWithCaret = document as Document & {
          caretPositionFromPoint?: (
            x: number,
            y: number,
          ) => { offsetNode: Node; offset: number } | null;
        };

        if (typeof docWithCaret.caretPositionFromPoint === "function") {
          const caretPosition = docWithCaret.caretPositionFromPoint(clientX, clientY);
          if (caretPosition) {
            const range = document.createRange();
            range.setStart(caretPosition.offsetNode, caretPosition.offset);
            range.collapse(true);
            return range;
          }
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (document as any).caretRangeFromPoint?.(clientX, clientY) ?? null;
      };

      const onMouseDown = (evt: MouseEvent) => {
        if (evt.button !== 0) return;
        const caretRange = getCaretRangeFromPoint(evt.clientX, evt.clientY);
        if (!caretRange) return;
        const caretSpan = getSelectableSpan(caretRange.startContainer);
        if (!caretSpan) return;
        if (!isPointInsideSpanBand(caretSpan, evt.clientX, evt.clientY, false)) return;

        evt.preventDefault();

        dragSelecting = true;
        anchorNode = caretRange.startContainer;
        anchorOffset = caretRange.startOffset;
        lastPointerX = evt.clientX;
        lastPointerY = evt.clientY;
        lastAppliedEndNode = anchorNode;
        lastAppliedEndOffset = anchorOffset;

        const sel = window.getSelection();
        if (!sel) return;
        sel.removeAllRanges();
        const collapsed = document.createRange();
        collapsed.setStart(anchorNode, anchorOffset);
        collapsed.collapse(true);
        sel.addRange(collapsed);
      };
      textLayerDiv.addEventListener("mousedown", onMouseDown);

      const applySelectionAtPoint = (clientX: number, clientY: number) => {
        if (!dragSelecting || !anchorNode) return;
        if (clientX === lastPointerX && clientY === lastPointerY) return;
        lastPointerX = clientX;
        lastPointerY = clientY;

        const caretRange = getCaretRangeFromPoint(clientX, clientY);
        if (!caretRange) return;
        const caretSpan = getSelectableSpan(caretRange.startContainer);
        if (!caretSpan) return;
        if (!isPointInsideSpanBand(caretSpan, clientX, clientY, true)) return;

        const endNode = caretRange.startContainer;
        const endOffset = caretRange.startOffset;

        // Avoid expensive removeAllRanges/addRange when caret endpoint
        // did not change since the previous frame.
        if (endNode === lastAppliedEndNode && endOffset === lastAppliedEndOffset) {
          return;
        }

        const cmp = anchorNode.compareDocumentPosition(endNode);
        const forward =
          cmp === 0
            ? anchorOffset <= endOffset
            : !!(cmp & Node.DOCUMENT_POSITION_FOLLOWING);

        const range = document.createRange();
        if (forward) {
          range.setStart(anchorNode, anchorOffset);
          range.setEnd(endNode, endOffset);
        } else {
          range.setStart(endNode, endOffset);
          range.setEnd(anchorNode, anchorOffset);
        }

        const sel = window.getSelection();
        if (!sel) return;
        sel.removeAllRanges();
        sel.addRange(range);

        lastAppliedEndNode = endNode;
        lastAppliedEndOffset = endOffset;
      };

      const onMouseMove = (evt: MouseEvent) => {
        if (!dragSelecting || !anchorNode) return;
        applySelectionAtPoint(evt.clientX, evt.clientY);
      };
      document.addEventListener("mousemove", onMouseMove);

      const onMouseUp = () => {
        dragSelecting = false;
        anchorNode = null;
        anchorOffset = 0;
        lastPointerX = -1;
        lastPointerY = -1;
        lastAppliedEndNode = null;
        lastAppliedEndOffset = -1;
      };
      document.addEventListener("mouseup", onMouseUp);

      // Store cleanup references so the effect teardown can remove them.
      cleanupSelectionRef.mousedown = onMouseDown;
      cleanupSelectionRef.mouseup = onMouseUp;
      cleanupSelectionRef.mousemove = onMouseMove;
      cleanupSelectionRef.selectstart = onSelectStart;
      cleanupSelectionRef.div = textLayerDiv;

      page.cleanup();
    })().catch(console.error);

    return () => {
      cancelled = true;
      // Cancel the in-flight pdf.js render task so it doesn't write to
      // the canvas after this component unmounts or re-renders
      try {
        (renderTask as any)?.cancel();
      } catch {
        /* ignore */
      }
      // Remove selection listeners from previous render cycle
      if (cleanupSelectionRef.div && cleanupSelectionRef.mousedown) {
        cleanupSelectionRef.div.removeEventListener(
          "mousedown",
          cleanupSelectionRef.mousedown,
        );
      }
      if (cleanupSelectionRef.div && cleanupSelectionRef.selectstart) {
        cleanupSelectionRef.div.removeEventListener(
          "selectstart",
          cleanupSelectionRef.selectstart,
        );
      }
      if (cleanupSelectionRef.mouseup) {
        document.removeEventListener("mouseup", cleanupSelectionRef.mouseup);
      }
      if (cleanupSelectionRef.mousemove) {
        document.removeEventListener(
          "mousemove",
          cleanupSelectionRef.mousemove,
        );
      }
      cleanupSelectionRef.mousedown = null;
      cleanupSelectionRef.mouseup = null;
      cleanupSelectionRef.mousemove = null;
      cleanupSelectionRef.selectstart = null;
      cleanupSelectionRef.div = null;
    };
  }, [pdf, pageNum, scale, cssWidth, cssHeight, _renderNonce]);

  return (
    <div
      ref={wrapRef}
      style={{
        position: "relative",
        width: cssWidth,
        height: cssHeight,
        flexShrink: 0,
        marginBottom: PAGE_GAP,
        boxShadow: "0 2px 8px rgba(0,0,0,0.5)",
        background: "#ffffff",
        cursor:
          activeTool === "sticky"
            ? "crosshair"
            : activeTool === "draw"
              ? "crosshair"
              : activeTool === "image"
                ? "crosshair"
                : activeTool === "eraser"
                  ? "crosshair"
                  : activeTool === "highlight"
                    ? "text"
                    : activeTool === "textbox"
                      ? "crosshair"
                      : "default",
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          display: "block",
          position: "absolute",
          top: 0,
          left: 0,
          pointerEvents: "none",
        }}
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
        annotations={annotations.filter((a) => a.page === pageNum)}
        onAnnotationCreated={onAnnotationCreated}
        onAnnotationDeleted={onAnnotationDeleted}
        onAnnotationUpdated={onAnnotationUpdated}
        fontSize={propFontSize}
        textColor={propTextColor}
        zoom={propZoom}
      />
    </div>
  );
});

/* ─── Placeholder for off-screen pages (keeps scroll height correct) ──────── */
const PagePlaceholder = React.memo(function PagePlaceholder({
  cssWidth,
  cssHeight,
}: {
  cssWidth: number;
  cssHeight: number;
}) {
  return (
    <div
      style={{
        width: cssWidth,
        height: cssHeight,
        flexShrink: 0,
        marginBottom: PAGE_GAP,
        background: "#1e1e1e",
        borderRadius: 2,
      }}
    />
  );
});

/* ═══════════════════════════════════════════════════════════════════════════════
   PDFViewer — main component
═══════════════════════════════════════════════════════════════════════════════ */
export const PDFViewer: React.FC<Props> = ({
  filePath,
  fileId = "",
  vaultPath = null,
  initialPage,
  scrollNonce,
}) => {
  const effectiveFileId = fileId || filePath;

  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [pageMeta, setPageMeta] = useState<PageMeta | null>(null); // uniform page size
  const [currentPage, setCurrentPage] = useState(1);
  const [zoom, setZoom] = useState(1.0);
  const [activeTool, setActiveTool] = useState<PDFTool>("none");
  const [hlColor, setHlColor] = useState("#fde68a");
  const [fontSize, setFontSize] = useState(14);
  const [textColor, setTextColor] = useState("#1a1a1a");
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [pendingAnnotations, setPendingAnnotations] = useState<Annotation[]>(
    [],
  );
  const [deletedAnnotationIds, setDeletedAnnotationIds] = useState<Set<string>>(
    new Set(),
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [visibleRange, setVisibleRange] = useState<[number, number]>([1, 3]);
  const [pdfLoadNonce, setPdfLoadNonce] = useState(0);
  const [renderNonce, setRenderNonce] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
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
      const page1 = await doc.getPage(1);
      const vp1 = page1.getViewport({ scale: 1 });
      const containerW = scrollRef.current?.clientWidth || 800;
      const baseScale = (containerW - 32) / vp1.width;
      baseScaleRef.current = baseScale;

      const vp = page1.getViewport({ scale: baseScale });
      setPageMeta({
        width: Math.floor(vp.width),
        height: Math.floor(vp.height),
      });
      setLoading(false);
    })().catch((err) => {
      console.error("[PDFViewer] load error", err);
      setError(String(err));
      setLoading(false);
    });
  }, [filePath, pdfLoadNonce]);

  /* ── Scroll to initialPage after load ───────────────────────────────────── */
  useEffect(() => {
    if (!initialPage || !pageMeta || !scrollRef.current || loading) return;
    const pageHeight = pageMeta.height * zoom;
    const target = (initialPage - 1) * (pageHeight + PAGE_GAP);
    scrollRef.current.scrollTop = target;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPage, scrollNonce, pageMeta, loading]);

  /* ── Annotations ─────────────────────────────────────────────────────────── */
  const loadAnnotations = useCallback(() => {
    if (!vaultPath) return;
    window.electronAPI
      .loadAnnotations(vaultPath, effectiveFileId)
      .then(setAnnotations)
      .catch(console.error);
  }, [effectiveFileId, vaultPath]);
  useEffect(() => {
    loadAnnotations();
  }, [loadAnnotations]);

  /* ── Listen for annotation saves from other windows ───────────────────────── */
  useEffect(() => {
    const normalizedLocal = filePath.replace(/\\/g, "/").toLowerCase();
    const unsub = window.electronAPI.onAnnotationsSaved((savedPath) => {
      const normalizedSaved = savedPath.replace(/\\/g, "/").toLowerCase();
      if (normalizedSaved === normalizedLocal) {
        pdfCache.delete(filePath);
        loadAnnotations();
        setPdfLoadNonce((n) => n + 1);
      }
    });
    return unsub;
  }, [filePath, loadAnnotations]);

  /* ── Listen for PDF file changes from other windows ──────────────────────── */
  useEffect(() => {
    const normalizedLocal = filePath.replace(/\\/g, "/").toLowerCase();
    const unsub = window.electronAPI.onPdfFileChanged((changedPath) => {
      const normalizedChanged = changedPath.replace(/\\/g, "/").toLowerCase();
      if (normalizedChanged !== normalizedLocal) return;
      pdfCache.delete(filePath);
      setPdfLoadNonce((n) => n + 1);
      loadAnnotations();
    });
    return unsub;
  }, [filePath, loadAnnotations]);

  /* ── Merged annotations (DB + pending - deleted) ─────────────────────────── */
  const mergedAnnotations = useMemo(() => {
    const dbAnns = annotations.filter((a) => !deletedAnnotationIds.has(a.id));
    // Deduplicate: pending might overlap with DB if loaded after a save
    const pendingIds = new Set(pendingAnnotations.map((a) => a.id));
    const combined = dbAnns.filter((a) => !pendingIds.has(a.id));
    return [...combined, ...pendingAnnotations];
  }, [annotations, pendingAnnotations, deletedAnnotationIds]);

  /* ── Dirty (unsaved changes) state ───────────────────────────────────────── */
  const hasUnsavedChanges =
    pendingAnnotations.length > 0 || deletedAnnotationIds.size > 0;

  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("pdfDirtyChange", {
        detail: { filePath, dirty: hasUnsavedChanges },
      }),
    );
  }, [filePath, hasUnsavedChanges]);

  /* ── Annotation callbacks (buffer, don't persist) ────────────────────────── */
  const onAnnotationCreated = useCallback((ann: Annotation) => {
    setPendingAnnotations((prev) => [...prev, ann]);
  }, []);

  const onAnnotationDeleted = useCallback((annId: string) => {
    // If it's a pending annotation, just remove from pending
    setPendingAnnotations((prev) => {
      const found = prev.find((a) => a.id === annId);
      if (found) return prev.filter((a) => a.id !== annId);
      return prev;
    });
    // If it was already in DB, mark for deletion
    setDeletedAnnotationIds((prev) => {
      const copy = new Set(prev);
      copy.add(annId);
      return copy;
    });
  }, []);

  const onAnnotationUpdated = useCallback((ann: Annotation) => {
    // Update in pending if it exists there, otherwise delete+re-create
    setPendingAnnotations((prev) => {
      const idx = prev.findIndex((a) => a.id === ann.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = ann;
        return next;
      }
      return prev;
    });
    // If it was a DB annotation, mark old for deletion and add updated as pending
    setAnnotations((prev) => {
      const idx = prev.findIndex((a) => a.id === ann.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = ann;
        return next;
      }
      return prev;
    });
    // Mark as dirty — delete the old DB version and re-add as pending
    setDeletedAnnotationIds((prev) => {
      const copy = new Set(prev);
      copy.add(ann.id);
      return copy;
    });
    setPendingAnnotations((prev) => {
      if (prev.find((a) => a.id === ann.id)) return prev;
      return [...prev, ann];
    });
  }, []);

  /* ── Save PDF ────────────────────────────────────────────────────────────── */
  const savePdf = useCallback(async () => {
    if (!filePath || saving) return;
    setSaving(true);
    try {
      // 1. Persist pending annotations to DB
      if (vaultPath) {
        for (const ann of pendingAnnotations) {
          await window.electronAPI.saveAnnotation(vaultPath, ann);
        }
        // 2. Delete erased annotations from DB
        for (const id of deletedAnnotationIds) {
          await window.electronAPI.deleteAnnotation(vaultPath, id);
        }
      }

      // 3. Bake visual annotations into the PDF binary
      const allAnns = mergedAnnotations;
      const fileBytes = await window.electronAPI.readFile(filePath);
      const pdfDoc = await PDFDocument.load(fileBytes);
      const pages = pdfDoc.getPages();

      for (const ann of allAnns) {
        const pageIdx = ann.page - 1;
        if (pageIdx < 0 || pageIdx >= pages.length) continue;
        const pdfPage = pages[pageIdx];
        const { width: pw, height: ph } = pdfPage.getSize();

        if (ann.type === "highlight") {
          const hl = ann as HighlightAnnotation;
          const hex = hl.color.replace("#", "");
          const cr = parseInt(hex.substring(0, 2), 16) / 255;
          const cg = parseInt(hex.substring(2, 4), 16) / 255;
          const cb = parseInt(hex.substring(4, 6), 16) / 255;
          for (const r of hl.rects) {
            pdfPage.drawRectangle({
              x: r.x * pw,
              y: (1 - r.y) * ph - r.h * ph,
              width: r.w * pw,
              height: r.h * ph,
              color: rgb(cr, cg, cb),
              opacity: 0.35,
            });
          }
        } else if (ann.type === "draw") {
          const dr = ann as DrawAnnotation;
          const hex = dr.color.replace("#", "");
          const cr = parseInt(hex.substring(0, 2), 16) / 255;
          const cg = parseInt(hex.substring(2, 4), 16) / 255;
          const cb = parseInt(hex.substring(4, 6), 16) / 255;
          for (let i = 0; i < dr.points.length - 1; i++) {
            const p1 = dr.points[i],
              p2 = dr.points[i + 1];
            pdfPage.drawLine({
              start: { x: p1.x * pw, y: (1 - p1.y) * ph },
              end: { x: p2.x * pw, y: (1 - p2.y) * ph },
              thickness: dr.strokeWidth,
              color: rgb(cr, cg, cb),
            });
          }
        }
      }

      const savedBytes = await pdfDoc.save();
      // Invalidate cache since file changed
      pdfCache.delete(filePath);
      await window.electronAPI.writeFile(filePath, new Uint8Array(savedBytes));

      // 4. Reindex PDF with annotation text
      if (vaultPath) {
        await window.electronAPI.reindexPdf(
          vaultPath,
          filePath,
          effectiveFileId,
        );
      }

      // 5. Clear pending state and reload from DB
      setPendingAnnotations([]);
      setDeletedAnnotationIds(new Set());
      loadAnnotations();
    } catch (err) {
      console.error("[PDFViewer] Save failed", err);
    } finally {
      setSaving(false);
    }
  }, [
    filePath,
    saving,
    vaultPath,
    pendingAnnotations,
    deletedAnnotationIds,
    mergedAnnotations,
    effectiveFileId,
    loadAnnotations,
  ]);

  /* ── Escape to deactivate tool / Ctrl+S to save ──────────────────────────── */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setActiveTool("none");
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        savePdf();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [savePdf]);

  /* ── Touchpad pinch-to-zoom ──────────────────────────────────────────────── */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    let pendingDelta = 0;
    let rafId: number | null = null;

    const applyZoom = () => {
      rafId = null;
      if (pendingDelta === 0) return;
      const delta = pendingDelta;
      pendingDelta = 0;
      setZoom((prev) => Math.min(4, Math.max(0.25, prev + delta)));
    };

    const handler = (e: WheelEvent) => {
      // Trackpad pinch gestures fire as wheel events with ctrlKey set
      if (!e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      pendingDelta += -e.deltaY * 0.01;
      if (rafId === null) {
        rafId = requestAnimationFrame(applyZoom);
      }
    };

    el.addEventListener("wheel", handler, { passive: false });
    return () => {
      el.removeEventListener("wheel", handler);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, []);

  /* ── Scroll-based virtualization + page tracking ──────────────────────────── */
  const prevZoomRef = useRef(zoom);
  const currentPageRef = useRef(currentPage);
  currentPageRef.current = currentPage;

  /* ── Synchronously correct scroll + visible range on zoom (before paint) ─── */
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !pageMeta || prevZoomRef.current === zoom) return;
    const prevZoom = prevZoomRef.current;
    prevZoomRef.current = zoom;

    // Proportionally scale scroll position so the same content stays in view
    const ratio = zoom / prevZoom;
    const scrollTop = el.scrollTop * ratio;
    el.scrollTop = scrollTop;

    // Update visible range in the same synchronous flush so pageList renders
    // correctly on the first paint — no intermediate wrong-range frame.
    const pageH = Math.floor(pageMeta.height * zoom) + PAGE_GAP;
    const viewportH = el.clientHeight;
    const firstVisible = Math.max(
      1,
      Math.floor((scrollTop - BUFFER_PX) / pageH) + 1,
    );
    const lastVisible = Math.min(
      numPages,
      Math.ceil((scrollTop + viewportH + BUFFER_PX) / pageH),
    );
    setVisibleRange([firstVisible, lastVisible]);
  }, [zoom, pageMeta, numPages]);

  /* ── Scroll-based virtualization + page tracking ──────────────────────────── */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !pageMeta) return;

    const computeRange = () => {
      const scrollTop = el.scrollTop;
      const viewportH = el.clientHeight;
      const pageH = Math.floor(pageMeta.height * zoom) + PAGE_GAP;
      if (pageH <= 0) return;

      // Current page = which page is at the center of the viewport
      const centerY = scrollTop + viewportH / 2;
      const centerPage = Math.max(
        1,
        Math.min(numPages, Math.ceil(centerY / pageH)),
      );
      setCurrentPage(centerPage);

      const firstVisible = Math.max(
        1,
        Math.floor((scrollTop - BUFFER_PX) / pageH) + 1,
      );
      const lastVisible = Math.min(
        numPages,
        Math.ceil((scrollTop + viewportH + BUFFER_PX) / pageH),
      );
      setVisibleRange([firstVisible, lastVisible]);
    };

    computeRange();
    el.addEventListener("scroll", computeRange, { passive: true });
    return () => el.removeEventListener("scroll", computeRange);
  }, [pageMeta, zoom, numPages]);

  /* ── Refit scale + force re-render when container goes hidden → visible ──── */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !pdf || loading) return;

    let prevW = el.clientWidth;
    let prevH = el.clientHeight;

    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      const wasHidden = prevW === 0 || prevH === 0;
      const nowVisible = w > 0 && h > 0;

      if (wasHidden && nowVisible) {
        // Recompute the fit-scale with the real container width in case the
        // PDF was loaded while the tab was hidden (display:none → clientWidth=0)
        (async () => {
          const page1 = await pdf.getPage(1);
          const vp1 = page1.getViewport({ scale: 1 });
          const newBase = (w - 32) / vp1.width;
          baseScaleRef.current = newBase;
          const vp = page1.getViewport({ scale: newBase });
          setPageMeta({
            width: Math.floor(vp.width),
            height: Math.floor(vp.height),
          });
          // Force GPU-discarded canvases to re-render
          setRenderNonce((n) => n + 1);
        })().catch(console.error);
      }

      prevW = w;
      prevH = h;
    });

    ro.observe(el);
    return () => ro.disconnect();
  }, [pdf, loading]);

  /* ── Build page list with virtualization ──────────────────────────────────── */
  const pageList = useMemo(() => {
    if (!pdf || !pageMeta) return null;
    const scale = baseScaleRef.current * zoom;
    const cssW = Math.floor(pageMeta.width * zoom);
    const cssH = Math.floor(pageMeta.height * zoom);
    const [lo, hi] = visibleRange;

    return Array.from({ length: numPages }, (_, i) => {
      const pageNum = i + 1;

      // Only render pages near the viewport; placeholders for the rest
      if (pageNum < lo || pageNum > hi) {
        return (
          <PagePlaceholder
            key={`ph-${pageNum}`}
            cssWidth={cssW}
            cssHeight={cssH}
          />
        );
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
          vaultPath={vaultPath ?? ""}
          annotations={mergedAnnotations}
          onAnnotationCreated={onAnnotationCreated}
          onAnnotationDeleted={onAnnotationDeleted}
          onAnnotationUpdated={onAnnotationUpdated}
          fontSize={fontSize}
          textColor={textColor}
          zoom={zoom}
          renderNonce={renderNonce}
        />
      );
    });
  }, [
    pdf,
    pageMeta,
    zoom,
    numPages,
    visibleRange,
    filePath,
    activeTool,
    hlColor,
    effectiveFileId,
    vaultPath,
    mergedAnnotations,
    onAnnotationCreated,
    onAnnotationDeleted,
    renderNonce,
  ]);

  /* ── Render ──────────────────────────────────────────────────────────────── */
  return (
    <div
      ref={containerRef}
      style={{
        height: "100%",
        width: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        background: "#141414",
      }}
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
        style={{
          flex: 1,
          overflowY: "auto",
          overflowX: "auto",
          background: "#141414",
          position: "relative",
        }}
      >
        {loading && (
          <div className="flex items-center justify-center h-full">
            <div className="text-[#6e6e6e] text-sm animate-pulse">
              Loading PDF…
            </div>
          </div>
        )}
        {error && (
          <div className="flex items-center justify-center h-full">
            <div className="text-red-400 text-sm max-w-xs text-center">
              Failed to load PDF:
              <br />
              <span className="text-[#8a8a8a] text-xs">{error}</span>
            </div>
          </div>
        )}
        {!loading && !error && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              padding: "16px",
              minHeight: "100%",
            }}
          >
            {pageList}
          </div>
        )}
        {!loading && !error && (
          <FloatingActionBar
            containerRef={scrollRef as React.RefObject<HTMLElement>}
            currentPage={currentPage}
            filePath={filePath}
            fileId={effectiveFileId}
            vaultPath={vaultPath ?? ""}
            onAnnotationCreated={onAnnotationCreated}
          />
        )}
      </div>
    </div>
  );
};
