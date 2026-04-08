import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  BlendMode,
  LineCapStyle,
  PDFDocument,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setLineCap,
  setLineJoin,
  LineJoinStyle,
  setGraphicsState,
} from "pdf-lib";

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

/** Module-level: page number where a drag-selection started.
 *  Used to keep that page mounted (skip virtualisation) so the
 *  anchor DOM node stays in the document during long cross-page drags. */
let activeDragAnchorPage: number | null = null;

const shouldRenderPersistedOverlay = (annotation: Annotation) =>
  annotation.type === "sticky" || annotation.type === "textbox";

/* ─── PDF document cache ───────────────────────────────────────────────────── */
const pdfCache = new Map<string, PDFDocumentProxy>();

// Evict cache entries when files are deleted (e.g. during note → PDF re-export)
// so reopening the same path reads the fresh file from disk.
if (typeof window !== 'undefined' && window.electronAPI?.onFileDeleted) {
  window.electronAPI.onFileDeleted((deletedPath) => {
    const norm = deletedPath.replace(/\\/g, '/').toLowerCase();
    for (const [key] of pdfCache) {
      if (key.replace(/\\/g, '/').toLowerCase() === norm) {
        pdfCache.delete(key);
      }
    }
  });
}

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
  /** Whether this viewer's tab is currently active/visible */
  isActive?: boolean;
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
  const [linkAnns, setLinkAnns] = useState<Array<{ rect: [number, number, number, number]; url: string; naturalHeight: number }>>([]);
  const cleanupSelectionRef = useRef<{
    mousedown: ((e: MouseEvent) => void) | null;
    mouseup: (() => void) | null;
    mousemove: ((e: MouseEvent) => void) | null;
    selectstart: ((e: Event) => void) | null;
    keydown: ((e: KeyboardEvent) => void) | null;
    dblclick: ((e: MouseEvent) => void) | null;
    div: HTMLDivElement | null;
  }>({
    mousedown: null,
    mouseup: null,
    mousemove: null,
    selectstart: null,
    keydown: null,
    dblclick: null,
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

  /* Fetch PDF link annotations for clickable URL overlays */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const page = await pdf.getPage(pageNum);
        if (cancelled) { page.cleanup(); return; }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rawAnns: any[] = await page.getAnnotations();
        if (cancelled) { page.cleanup(); return; }
        const viewport = page.getViewport({ scale: 1 });
        const naturalHeight = viewport.height;
        const links = rawAnns
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .filter((a: any) => a.subtype === 'Link' && typeof a.url === 'string' && /^https?:\/\//i.test(a.url))
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map((a: any) => ({ rect: a.rect as [number, number, number, number], url: a.url as string, naturalHeight }));
        setLinkAnns(links);
        page.cleanup();
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [pdf, pageNum]);

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

      const rawDpr = window.devicePixelRatio || 1;
      // Cap DPR to avoid enormous canvas sizes on high-DPI displays,
      // which cause image-heavy PDFs to render very slowly.
      const dpr = Math.min(rawDpr, 2);
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
      let rafPending = false;

      // Reusable Range to avoid per-move allocations
      const reusableRange = document.createRange();
      // Cache the Selection object
      const cachedSel = window.getSelection();

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
        if (!span || !span.closest('.textLayer')) return null;
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
            ? Math.min(Math.max(rect.height * 0.08, 0.5), maxInset)
            : Math.min(Math.max(rect.height * 0.01, 0), maxInset);
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

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const caretRangeFromPoint: ((x: number, y: number) => Range | null) | undefined =
        (document as any).caretRangeFromPoint?.bind(document);

      const getCaretRangeFromPoint = (
        clientX: number,
        clientY: number,
      ): Range | null => {
        return caretRangeFromPoint?.(clientX, clientY) ?? null;
      };

      const selectWord = (textNode: Node, offset: number) => {
        if (textNode.nodeType !== Node.TEXT_NODE || !cachedSel) return;
        const text = textNode.textContent || "";
        let start = offset;
        let end = offset;
        const isWordChar = (c: string) => /\w/.test(c);
        if (offset < text.length && isWordChar(text[offset])) {
          while (start > 0 && isWordChar(text[start - 1])) start--;
          while (end < text.length && isWordChar(text[end])) end++;
        } else if (offset > 0 && isWordChar(text[offset - 1])) {
          while (start > 0 && isWordChar(text[start - 1])) start--;
          while (end < text.length && isWordChar(text[end])) end++;
        }
        if (start !== end) {
          reusableRange.setStart(textNode, start);
          reusableRange.setEnd(textNode, end);
          cachedSel.removeAllRanges();
          cachedSel.addRange(reusableRange);
        }
      };

      const selectLine = (span: HTMLElement) => {
        if (!cachedSel) return;
        reusableRange.selectNodeContents(span);
        cachedSel.removeAllRanges();
        cachedSel.addRange(reusableRange);
      };

      const clearTextLayerSelection = () => {
        if (!cachedSel || cachedSel.rangeCount === 0) return;
        const range = cachedSel.getRangeAt(0);
        if (
          textLayerDiv.contains(range.startContainer) ||
          textLayerDiv.contains(range.endContainer)
        ) {
          cachedSel.removeAllRanges();
        }
      };

      const onDblClick = (evt: MouseEvent) => {
        const caretRange = getCaretRangeFromPoint(evt.clientX, evt.clientY);
        if (!caretRange) return;
        const caretSpan = getSelectableSpan(caretRange.startContainer);
        if (!caretSpan) return;
        evt.preventDefault();
        selectWord(caretRange.startContainer, caretRange.startOffset);
      };
      textLayerDiv.addEventListener("dblclick", onDblClick);

      const onMouseDown = (evt: MouseEvent) => {
        if (evt.button !== 0) return;
        const caretRange = getCaretRangeFromPoint(evt.clientX, evt.clientY);
        if (!caretRange) {
          clearTextLayerSelection();
          return;
        }
        const caretSpan = getSelectableSpan(caretRange.startContainer);
        if (!caretSpan) {
          clearTextLayerSelection();
          return;
        }
        if (!isPointInsideSpanBand(caretSpan, evt.clientX, evt.clientY, false)) {
          clearTextLayerSelection();
          return;
        }

        evt.preventDefault();

        // Triple-click: select entire span/line
        if (evt.detail >= 3) {
          selectLine(caretSpan);
          return;
        }

        // Double-click: select word
        if (evt.detail === 2) {
          selectWord(caretRange.startContainer, caretRange.startOffset);
          return;
        }

        // Shift+Click: extend existing selection to the clicked point
        if (evt.shiftKey && cachedSel && cachedSel.rangeCount > 0) {
          const existing = cachedSel.getRangeAt(0);
          const clickNode = caretRange.startContainer;
          const clickOff = caretRange.startOffset;
          // Keep the opposite end of the current selection as anchor
          const cmp = existing.startContainer.compareDocumentPosition(clickNode);
          const clickIsAfterStart =
            cmp === 0
              ? existing.startOffset <= clickOff
              : !!(cmp & Node.DOCUMENT_POSITION_FOLLOWING);
          if (clickIsAfterStart) {
            reusableRange.setStart(existing.startContainer, existing.startOffset);
            reusableRange.setEnd(clickNode, clickOff);
          } else {
            reusableRange.setStart(clickNode, clickOff);
            reusableRange.setEnd(existing.endContainer, existing.endOffset);
          }
          cachedSel.removeAllRanges();
          cachedSel.addRange(reusableRange);
          return;
        }

        // Single click: start drag selection
        dragSelecting = true;
        anchorNode = caretRange.startContainer;
        anchorOffset = caretRange.startOffset;
        lastAppliedEndNode = anchorNode;
        lastAppliedEndOffset = anchorOffset;
        activeDragAnchorPage = pageNum;

        if (!cachedSel) return;
        reusableRange.setStart(anchorNode, anchorOffset);
        reusableRange.collapse(true);
        cachedSel.removeAllRanges();
        cachedSel.addRange(reusableRange);
      };
      textLayerDiv.addEventListener("mousedown", onMouseDown);

      const isInputFocused = () => {
        const active = document.activeElement;
        return (
          active &&
          (active.tagName === "INPUT" ||
            active.tagName === "TEXTAREA" ||
            (active as HTMLElement).isContentEditable)
        );
      };

      const hasSelectionInTextLayer = () => {
        if (!cachedSel || cachedSel.rangeCount === 0) return false;
        const r = cachedSel.getRangeAt(0);
        return (
          !r.collapsed &&
          textLayerDiv.contains(r.startContainer)
        );
      };

      const onKeyDown = (evt: KeyboardEvent) => {
        const ctrl = evt.ctrlKey || evt.metaKey;

        // --- Escape: clear selection -----------------------------------------------
        if (evt.key === "Escape" && hasSelectionInTextLayer()) {
          cachedSel?.removeAllRanges();
          return;
        }

        // --- Ctrl+C: copy selected text --------------------------------------------
        if (ctrl && evt.key === "c" && hasSelectionInTextLayer()) {
          const text = cachedSel!.toString();
          if (text) {
            evt.preventDefault();
            navigator.clipboard.writeText(text);
          }
          return;
        }

        // --- Ctrl+A: select all text in hovered page text layer --------------------
        if (ctrl && evt.key === "a") {
          if (isInputFocused()) return;
          if (!textLayerDiv.closest(".pdf-page-wrapper:hover")) return;
          evt.preventDefault();
          if (cachedSel) {
            reusableRange.selectNodeContents(textLayerDiv);
            cachedSel.removeAllRanges();
            cachedSel.addRange(reusableRange);
          }
          return;
        }

        // --- Keyboard selection extension (Shift+Arrow, Shift+Home/End, etc.) ------
        // Only act when there is already a selection inside this text layer,
        // or a collapsed caret inside it.
        if (!evt.shiftKey) return;
        if (isInputFocused()) return;
        if (!cachedSel || cachedSel.rangeCount === 0) return;
        const curRange = cachedSel.getRangeAt(0);
        if (!textLayerDiv.contains(curRange.startContainer)) return;

        // Use Selection.modify() — non-standard but supported in all Chromium
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sel = cachedSel as any;
        if (typeof sel.modify !== "function") return;

        let granularity: string | null = null;
        let direction: "forward" | "backward" | null = null;

        switch (evt.key) {
          case "ArrowRight":
            granularity = ctrl ? "word" : "character";
            direction = "forward";
            break;
          case "ArrowLeft":
            granularity = ctrl ? "word" : "character";
            direction = "backward";
            break;
          case "ArrowDown":
            granularity = "line";
            direction = "forward";
            break;
          case "ArrowUp":
            granularity = "line";
            direction = "backward";
            break;
          case "Home":
            granularity = ctrl ? "documentboundary" : "lineboundary";
            direction = "backward";
            break;
          case "End":
            granularity = ctrl ? "documentboundary" : "lineboundary";
            direction = "forward";
            break;
          default:
            return;
        }

        if (granularity && direction) {
          evt.preventDefault();
          sel.modify("extend", direction, granularity);
        }
      };
      document.addEventListener("keydown", onKeyDown);

      const applySelectionAtPoint = (clientX: number, clientY: number) => {
        if (!dragSelecting || !anchorNode || !cachedSel) return;

        // If the anchor node was detached (page virtualised / re-rendered),
        // abort the drag — the selection can't be extended.
        if (!document.contains(anchorNode)) {
          dragSelecting = false;
          anchorNode = null;
          activeDragAnchorPage = null;
          return;
        }

        const caretRange = getCaretRangeFromPoint(clientX, clientY);
        if (!caretRange) return;
        const endNode = caretRange.startContainer;
        const endOffset = caretRange.startOffset;

        const caretSpan = getSelectableSpan(endNode);
        if (!caretSpan) return;

        // Use loose band checking during drag — much more forgiving than strict
        // (strict insets 8% vertically, loose insets ~1%) so the selection
        // doesn't get stuck, but still prevents bleeding through whitespace gaps.
        if (!isPointInsideSpanBand(caretSpan, clientX, clientY, false)) return;

        // Skip if caret didn't move
        if (endNode === lastAppliedEndNode && endOffset === lastAppliedEndOffset) return;

        const cmp = anchorNode.compareDocumentPosition(endNode);
        const forward =
          cmp === 0
            ? anchorOffset <= endOffset
            : !!(cmp & Node.DOCUMENT_POSITION_FOLLOWING);

        try {
          if (forward) {
            reusableRange.setStart(anchorNode, anchorOffset);
            reusableRange.setEnd(endNode, endOffset);
          } else {
            reusableRange.setStart(endNode, endOffset);
            reusableRange.setEnd(anchorNode, anchorOffset);
          }

          cachedSel.removeAllRanges();
          cachedSel.addRange(reusableRange);

          lastAppliedEndNode = endNode;
          lastAppliedEndOffset = endOffset;
        } catch {
          // Range endpoints in incompatible DOM subtrees — keep existing selection
        }
      };

      const onMouseMove = (evt: MouseEvent) => {
        if (!dragSelecting || !anchorNode) return;
        // Throttle to one update per animation frame for smooth 60fps selection
        if (rafPending) return;
        rafPending = true;
        const cx = evt.clientX;
        const cy = evt.clientY;
        requestAnimationFrame(() => {
          rafPending = false;
          applySelectionAtPoint(cx, cy);
        });
      };
      document.addEventListener("mousemove", onMouseMove);

      const onMouseUp = () => {
        dragSelecting = false;
        anchorNode = null;
        anchorOffset = 0;
        rafPending = false;
        lastAppliedEndNode = null;
        lastAppliedEndOffset = -1;
        activeDragAnchorPage = null;
      };
      document.addEventListener("mouseup", onMouseUp);

      // Store cleanup references so the effect teardown can remove them.
      cleanupSelectionRef.mousedown = onMouseDown;
      cleanupSelectionRef.mouseup = onMouseUp;
      cleanupSelectionRef.mousemove = onMouseMove;
      cleanupSelectionRef.selectstart = onSelectStart;
      cleanupSelectionRef.keydown = onKeyDown;
      cleanupSelectionRef.dblclick = onDblClick;
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
      if (cleanupSelectionRef.keydown) {
        document.removeEventListener("keydown", cleanupSelectionRef.keydown);
      }
      if (cleanupSelectionRef.div && cleanupSelectionRef.dblclick) {
        cleanupSelectionRef.div.removeEventListener(
          "dblclick",
          cleanupSelectionRef.dblclick,
        );
      }
      cleanupSelectionRef.mousedown = null;
      cleanupSelectionRef.mouseup = null;
      cleanupSelectionRef.mousemove = null;
      cleanupSelectionRef.selectstart = null;
      cleanupSelectionRef.keydown = null;
      cleanupSelectionRef.dblclick = null;
      cleanupSelectionRef.div = null;
    };
  }, [pdf, pageNum, scale, cssWidth, cssHeight, _renderNonce]);

  return (
    <div
      ref={wrapRef}
      className="pdf-page-wrapper"
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
              : activeTool === "eraser"
                ? "crosshair"
                : activeTool === "highlight"
                  ? "crosshair"
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
      {/* ── PDF link annotation overlays ── */}
      {linkAnns.map((link, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            left: link.rect[0] * scale,
            top: (link.naturalHeight - link.rect[3]) * scale,
            width: (link.rect[2] - link.rect[0]) * scale,
            height: (link.rect[3] - link.rect[1]) * scale,
            cursor: activeTool === 'none' ? 'pointer' : 'default',
            pointerEvents: activeTool === 'none' ? 'auto' : 'none',
            zIndex: 4,
          }}
          onClick={(e) => {
            e.stopPropagation();
            window.electronAPI.openExternal(link.url);
          }}
          title={link.url}
        />
      ))}
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
  isActive = true,
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
  /** Scroll position to restore after a save-triggered reload */
  const pendingRestoreScrollRef = useRef<number | null>(null);
  /** Scroll position saved when the tab becomes inactive, so we can restore it
   *  when the tab becomes visible again (browsers reset scrollTop on display:none). */
  const savedScrollTopRef = useRef<number | null>(null);
  /** Tracks the last applied initialPage + scrollNonce so the effect doesn't
   *  re-scroll when only pageMeta changes (e.g. after a tab switch). */
  const appliedInitialScrollRef = useRef<string | null>(null);

  /* ── Toast state for "Note saved" notification ───────────────────────────── */
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const { noteTitle } = (e as CustomEvent<{ noteTitle: string }>).detail;
      setToastMessage(`Note saved to ${noteTitle}`);
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      toastTimerRef.current = setTimeout(() => setToastMessage(null), 5000);
    };
    window.addEventListener('noteSavedToast', handler);
    return () => {
      window.removeEventListener('noteSavedToast', handler);
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  /* ── Search state ────────────────────────────────────────────────────────── */
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMatches, setSearchMatches] = useState<Array<{ page: number; indexInPage: number }>>([]); 
  const [currentMatchIdx, setCurrentMatchIdx] = useState(0);
  const pageTextsRef = useRef<Map<number, { items: string[]; fullText: string }>>(new Map());
  const searchInputRef = useRef<HTMLInputElement>(null);
  const highlightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastScrolledMatchRef = useRef<number>(-1);

  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const visiblePages = useRef(new Set<number>());
  const baseScaleRef = useRef(1);
  const isPanning = useRef(false);
  const panStart = useRef({ x: 0, y: 0, scrollLeft: 0, scrollTop: 0 });
  const prevActiveRef = useRef(isActive);
  // Keep a ref to the latest DB annotations so onAnnotationUpdated can check
  // whether an annotation is already persisted without needing it as a dep.
  const annotationsRef = useRef<Annotation[]>([]);
  useEffect(() => { annotationsRef.current = annotations; }, [annotations]);

  /* ── Load PDF (fast — only reads page 1 for sizing) ──────────────────────── */
  useEffect(() => {
    if (!filePath) return;
    setLoading(true);
    setError(null);
    setPdf(null);
    setNumPages(0);
    setPageMeta(null);
    // Only reset currentPage when not restoring scroll after save
    if (pendingRestoreScrollRef.current == null) {
      setCurrentPage(1);
    }
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

      // Restore scroll position after a save-triggered reload
      if (pendingRestoreScrollRef.current != null) {
        const savedScroll = pendingRestoreScrollRef.current;
        pendingRestoreScrollRef.current = null;
        // Use double-rAF to ensure the DOM has fully laid out the page list
        // before restoring scroll. A single rAF sometimes fires before layout
        // is complete, causing the scroll to not stick.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (scrollRef.current) {
              scrollRef.current.scrollTop = savedScroll;
              // Immediately recompute visible range so the virtualization
              // doesn't flash the wrong pages before the scroll event fires.
              const viewportH = scrollRef.current.clientHeight;
              const pageH = Math.floor(vp.height) + PAGE_GAP;
              if (pageH > 0 && viewportH > 0) {
                const firstVisible = Math.max(1, Math.floor((savedScroll - BUFFER_PX) / pageH) + 1);
                const lastVisible = Math.min(n, Math.ceil((savedScroll + viewportH + BUFFER_PX) / pageH));
                setVisibleRange([firstVisible, lastVisible]);
                const centerY = savedScroll + viewportH / 2;
                setCurrentPage(Math.max(1, Math.min(n, Math.ceil(centerY / pageH))));
              }
            }
          });
        });
      }
    })().catch((err) => {
      console.error("[PDFViewer] load error", err);
      setError(String(err));
      setLoading(false);
    });
  }, [filePath, pdfLoadNonce]);

  /* ── Restore scroll position + repaint when tab becomes active again ─────── */
  useEffect(() => {
    const wasActive = prevActiveRef.current;
    prevActiveRef.current = isActive;

    // Tab just became ACTIVE — restore scroll and recompute visible range.
    // Scroll position was saved continuously by the scroll handler (see
    // computeRange below).  We cannot save it on deactivation because
    // the useEffect fires AFTER display:none is applied and scrollTop is
    // already reset to 0.
    if (!wasActive && isActive && pageMeta && !loading) {
      const el = scrollRef.current;
      if (el) {
        // Restore the saved scroll position (the browser has reset it to 0).
        if (savedScrollTopRef.current != null) {
          el.scrollTop = savedScrollTopRef.current;
        }
        // Use rAF to wait for the element to be visible and laid out before
        // recomputing the visible range; clientHeight is 0 until layout.
        requestAnimationFrame(() => {
          if (!scrollRef.current) return;
          // Re-apply saved scroll in case DOM wasn't ready on the first set.
          if (savedScrollTopRef.current != null) {
            scrollRef.current.scrollTop = savedScrollTopRef.current;
          }
          const scrollTop = scrollRef.current.scrollTop;
          const viewportH = scrollRef.current.clientHeight;
          const pageH = Math.floor(pageMeta.height * zoom) + PAGE_GAP;
          if (pageH > 0 && viewportH > 0) {
            const firstVisible = Math.max(
              1,
              Math.floor((scrollTop - BUFFER_PX) / pageH) + 1,
            );
            const lastVisible = Math.min(
              numPages,
              Math.ceil((scrollTop + viewportH + BUFFER_PX) / pageH),
            );
            setVisibleRange([firstVisible, lastVisible]);
            // Update currentPage to match restored scroll position
            const centerY = scrollTop + viewportH / 2;
            setCurrentPage(Math.max(1, Math.min(numPages, Math.ceil(centerY / pageH))));
          }
          // Canvas backing stores may have been discarded by the GPU while hidden.
          // Bump renderNonce so every visible PDFPage re-paints its canvas.
          setRenderNonce((n) => n + 1);
        });
      }
    }
  }, [isActive, pageMeta, loading, zoom, numPages]);

  /* ── Guard against DOM-reorder scroll resets (e.g. tab drag) ──────────────
     When React reorders sibling components (same key, different position in
     the children array), the browser detaches and reattaches the DOM node,
     resetting scrollTop to 0.  This runs synchronously before paint so we
     can restore the saved position before the user sees a flash.  We skip
     the fix during tab activation (handled above) and initial load.          */
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !isActive || loading || !pageMeta) return;
    // If scrollTop is now 0 but we had a saved position > 0, the browser
    // must have reset it due to DOM reorder.
    if (
      el.scrollTop === 0 &&
      savedScrollTopRef.current != null &&
      savedScrollTopRef.current > 0
    ) {
      el.scrollTop = savedScrollTopRef.current;
    }
  });

  /* ── Scroll to initialPage after load ───────────────────────────────────── */
  useEffect(() => {
    if (!initialPage || !pageMeta || !scrollRef.current || loading) return;
    // Only scroll when initialPage or scrollNonce actually changed, not when
    // pageMeta is recalculated (e.g. ResizeObserver on tab switch).
    const key = `${initialPage}-${scrollNonce ?? 0}`;
    if (appliedInitialScrollRef.current === key) return;
    appliedInitialScrollRef.current = key;

    const el = scrollRef.current;
    // Use the same floored page height as computeRange() so scroll position
    // and visible-range boundaries are always in sync.
    const pageH = Math.floor(pageMeta.height * zoom) + PAGE_GAP;
    const target = (initialPage - 1) * pageH;
    el.scrollTop = target;

    // Update visibleRange now — setting scrollTop fires the scroll event
    // asynchronously, so without this the first render after a jump still
    // shows the old range and the target page renders as a blank placeholder.
    const viewportH = el.clientHeight || 600;
    const firstVisible = Math.max(1, Math.floor((target - BUFFER_PX) / pageH) + 1);
    const lastVisible = Math.min(numPages, Math.ceil((target + viewportH + BUFFER_PX) / pageH));
    setVisibleRange([firstVisible, lastVisible]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPage, scrollNonce, pageMeta, loading]);

  /* ── Annotations ─────────────────────────────────────────────────────────── */
  const loadAnnotations = useCallback(() => {
    if (!vaultPath) return;
    window.electronAPI
      .loadAnnotations(vaultPath, effectiveFileId)
      // Highlights and pen strokes are flattened into the PDF on save,
      // so reloading them as live overlays would draw them a second time.
      .then((data) => setAnnotations(data.filter(shouldRenderPersistedOverlay)))
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
    const isInDb = annotationsRef.current.some((a) => a.id === annId);

    // If it's pending, remove the queued version first.
    setPendingAnnotations((prev) => {
      const found = prev.find((a) => a.id === annId);
      if (found) return prev.filter((a) => a.id !== annId);
      return prev;
    });

    // Only persisted annotations need a DB delete on save.
    if (!isInDb) return;

    setDeletedAnnotationIds((prev) => {
      const copy = new Set(prev);
      copy.add(annId);
      return copy;
    });
  }, []);

  const onAnnotationUpdated = useCallback((ann: Annotation) => {
    const isInDb = annotationsRef.current.some((a) => a.id === ann.id);

    if (isInDb) {
      // DB annotation: optimistically update local state and queue the latest
      // version for persistence. Saving with the same id already replaces the
      // existing DB row, so this must not also be marked for deletion.
      setAnnotations((prev) => {
        const idx = prev.findIndex((a) => a.id === ann.id);
        if (idx < 0) return prev;
        const next = [...prev];
        next[idx] = ann;
        return next;
      });
      setDeletedAnnotationIds((prev) => {
        if (!prev.has(ann.id)) return prev;
        const copy = new Set(prev);
        copy.delete(ann.id);
        return copy;
      });
      setPendingAnnotations((prev) => {
        const idx = prev.findIndex((a) => a.id === ann.id);
        if (idx < 0) return [...prev, ann];
        const next = [...prev];
        next[idx] = ann;
        return next;
      });
    } else {
      // Purely pending annotation (not yet saved to DB): just update it
      // in-place so we never accidentally mark it for DB deletion.
      setPendingAnnotations((prev) => {
        const idx = prev.findIndex((a) => a.id === ann.id);
        if (idx < 0) return prev;
        const next = [...prev];
        next[idx] = ann;
        return next;
      });
    }
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
      let fileBytes: Uint8Array;
      try {
        fileBytes = await window.electronAPI.readFile(filePath);
      } catch (readErr) {
        console.error("[PDFViewer] Failed to read PDF for save:", readErr);
        setToastMessage("Save failed: could not read PDF file");
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        toastTimerRef.current = setTimeout(() => setToastMessage(null), 5000);
        return;
      }

      let pdfDoc;
      try {
        pdfDoc = await PDFDocument.load(fileBytes, {
          throwOnInvalidObject: false,
        });
      } catch (loadErr) {
        console.error("[PDFViewer] Failed to parse PDF for save:", loadErr);
        setToastMessage("Save failed: PDF may be corrupted");
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        toastTimerRef.current = setTimeout(() => setToastMessage(null), 5000);
        return;
      }

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
              opacity: 0.4,
              blendMode: BlendMode.Multiply,
            });
          }
        } else if (ann.type === "draw") {
          const dr = ann as DrawAnnotation;
          if (dr.points.length < 2) continue;
          const hex = dr.color.replace("#", "");
          const cr = parseInt(hex.substring(0, 2), 16) / 255;
          const cg = parseInt(hex.substring(2, 4), 16) / 255;
          const cb = parseInt(hex.substring(4, 6), 16) / 255;
          const isFreehandHighlight = dr.strokeWidth >= 10;

          // Scale strokeWidth from CSS pixels to PDF points.
          // In the SVG overlay the stroke is in CSS pixels on a canvas of
          // (pageMeta.width * zoom) px.  In the PDF the same dimension is pw
          // points.  Dividing by the ratio keeps the visual size consistent.
          const cssPageWidth = (pageMeta?.width ?? pw) * zoom;
          const pdfStrokeWidth = dr.strokeWidth * (pw / cssPageWidth);

          // Build an SVG path string from the points.
          // pdf-lib's drawSvgPath uses the PDF coordinate system
          // (origin = bottom-left), and we pass x/y to position the origin.
          // So we build relative to (0,0) and use x/y offset = first point.
          const firstPt = dr.points[0];
          const originX = firstPt.x * pw;
          const originY = (1 - firstPt.y) * ph;
          let svgPath = "M 0 0";
          for (let i = 1; i < dr.points.length; i++) {
            const pt = dr.points[i];
            const dx = pt.x * pw - originX;
            // SVG y goes down, but pdf-lib flips it, so negate
            const dy = -(((1 - pt.y) * ph) - originY);
            svgPath += ` L ${dx} ${dy}`;
          }

          // Push graphics state, set round line cap & join
          pdfPage.pushOperators(
            pushGraphicsState(),
            setLineCap(LineCapStyle.Round),
            setLineJoin(LineJoinStyle.Round),
          );

          if (isFreehandHighlight) {
            // Create an ExtGState with transparency for the highlight effect
            const extGState = pdfDoc.context.obj({
              Type: 'ExtGState',
              CA: 0.4,  // stroke opacity
              ca: 0.4,  // fill opacity
              BM: 'Multiply',
            });
            const extGStateRef = pdfDoc.context.register(extGState);
            // Add the ExtGState to the page's resources
            const pageDict = pdfPage.node;
            let resources = pageDict.get(pdfDoc.context.obj('Resources') as any) as any;
            if (!resources) {
              resources = pageDict.lookup(pdfDoc.context.obj('Resources') as any) as any;
            }
            // Use a unique name for this ExtGState
            const gsName = `GS_HL_${ann.id.replace(/-/g, '').substring(0, 8)}`;
            pdfPage.node.setExtGState(
              pdfDoc.context.obj(gsName) as any,
              extGStateRef,
            );
            pdfPage.pushOperators(setGraphicsState(gsName));
          }

          pdfPage.drawSvgPath(svgPath, {
            x: originX,
            y: originY,
            borderColor: rgb(cr, cg, cb),
            borderWidth: pdfStrokeWidth,
            borderLineCap: LineCapStyle.Round,
          });

          pdfPage.pushOperators(popGraphicsState());
        }
      }

      let savedBytes: Uint8Array;
      try {
        savedBytes = await pdfDoc.save();
      } catch (saveErr) {
        console.error("[PDFViewer] Failed to serialize PDF:", saveErr);
        setToastMessage("Save failed: could not serialize PDF");
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        toastTimerRef.current = setTimeout(() => setToastMessage(null), 5000);
        return;
      }

      // Invalidate cache since file changed
      pdfCache.delete(filePath);
      try {
        await window.electronAPI.writeFile(filePath, new Uint8Array(savedBytes));
      } catch (writeErr) {
        console.error("[PDFViewer] Failed to write PDF:", writeErr);
        setToastMessage("Save failed: could not write PDF file");
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        toastTimerRef.current = setTimeout(() => setToastMessage(null), 5000);
        return;
      }

      // 4. Reindex PDF with annotation text.
      // Non-fatal: a reindex failure must never block the dirty-state clear.
      if (vaultPath) {
        try {
          await window.electronAPI.reindexPdf(
            vaultPath,
            filePath,
            effectiveFileId,
          );
        } catch (indexErr) {
          console.warn('[PDFViewer] Reindex after save failed (non-fatal):', indexErr);
        }
      }

      // 5. Clear pending state and reload from DB
      // Capture scroll position before reloading so we can restore it
      if (scrollRef.current) {
        pendingRestoreScrollRef.current = scrollRef.current.scrollTop;
      }
      setPendingAnnotations([]);
      setDeletedAnnotationIds(new Set());
      loadAnnotations();
      setPdfLoadNonce((n) => n + 1);
    } catch (err) {
      console.error("[PDFViewer] Save failed", err);
      setToastMessage("Save failed: unexpected error");
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      toastTimerRef.current = setTimeout(() => setToastMessage(null), 5000);
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
    pageMeta,
    zoom,
  ]);

  /* ── PDF text search ──────────────────────────────────────────────────────── */

  // Extract text from all pages when search is opened
  useEffect(() => {
    if (!showSearch || !pdf || pageTextsRef.current.size === numPages) return;
    let cancelled = false;
    (async () => {
      const texts = new Map<number, { items: string[]; fullText: string }>();
      for (let i = 1; i <= numPages; i++) {
        if (cancelled) return;
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const items = content.items
          .filter((item: any) => "str" in item)
          .map((item: any) => item.str as string);
        texts.set(i, { items, fullText: items.join("") });
        page.cleanup();
      }
      if (!cancelled) pageTextsRef.current = texts;
      // trigger match recomputation
      if (!cancelled) setSearchQuery((q) => q);
    })();
    return () => { cancelled = true; };
  }, [showSearch, pdf, numPages]);

  // Clear cached page texts when PDF changes
  useEffect(() => {
    pageTextsRef.current = new Map();
  }, [filePath, pdfLoadNonce]);

  // Find matches when query changes
  const doSearch = useCallback((query: string) => {
    if (!query) { setSearchMatches([]); return; }
    const lowerQ = query.toLowerCase();
    const matches: Array<{ page: number; indexInPage: number }> = [];
    for (let p = 1; p <= numPages; p++) {
      const info = pageTextsRef.current.get(p);
      if (!info) continue;
      const lowerText = info.fullText.toLowerCase();
      let idx = 0;
      let matchIndex = 0;
      while ((idx = lowerText.indexOf(lowerQ, idx)) !== -1) {
        matches.push({ page: p, indexInPage: matchIndex });
        idx += lowerQ.length;
        matchIndex++;
      }
    }
    setSearchMatches(matches);
    // Pick the first match at or after the current viewport position
    if (matches.length > 0) {
      const viewPage = currentPage;
      let startIdx = matches.findIndex((m) => m.page >= viewPage);
      if (startIdx < 0) startIdx = 0; // wrap to beginning if all matches are before
      setCurrentMatchIdx(startIdx);
      lastScrolledMatchRef.current = -1;
      prevScrolledForIdx.current = -1;
    }
  }, [numPages, currentPage]);

  // Run search whenever query changes
  useEffect(() => { doSearch(searchQuery); }, [searchQuery, doSearch]);

  // Scroll to current match's page when the user navigates to a new match.
  // We track lastScrolledMatchRef so we only scroll on actual navigation,
  // not when visibleRange or renderNonce change (which would lock scrolling).
  useEffect(() => {
    if (searchMatches.length === 0 || !scrollRef.current || !pageMeta) return;
    if (lastScrolledMatchRef.current === currentMatchIdx) return;
    lastScrolledMatchRef.current = currentMatchIdx;
    const match = searchMatches[currentMatchIdx];
    if (!match) return;
    const el = scrollRef.current;
    const pageH = Math.floor(pageMeta.height * zoom) + PAGE_GAP;
    const target = (match.page - 1) * pageH;
    // Scroll to top-of-page so the text layer is guaranteed to render;
    // applySearchHighlights will then refine to the exact match position.
    el.scrollTop = target;
  }, [currentMatchIdx, searchMatches, pageMeta, zoom]);

  // Apply CSS Custom Highlight API to visible text layers
  const applySearchHighlights = useCallback(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cssHighlights = (CSS as any).highlights;
    if (!cssHighlights) return;
    cssHighlights.delete("pdf-search");
    cssHighlights.delete("pdf-search-current");
    if (!showSearch || !searchQuery || searchMatches.length === 0) return;

    const container = scrollRef.current;
    if (!container) return;
    const lowerQ = searchQuery.toLowerCase();
    const allRanges: Range[] = [];
    const currentRanges: Range[] = [];

    // Determine which match index is current for each page
    let matchCounter = 0;
    const pageMatchOffsets = new Map<number, number>(); // page -> global offset of first match on this page
    for (let p = 1; p <= numPages; p++) {
      pageMatchOffsets.set(p, matchCounter);
      const info = pageTextsRef.current.get(p);
      if (!info) continue;
      const lowerText = info.fullText.toLowerCase();
      let idx = 0;
      while ((idx = lowerText.indexOf(lowerQ, idx)) !== -1) {
        matchCounter++;
        idx += lowerQ.length;
      }
    }

    // Find all text layers in the scroll container
    const scrollInner = container.querySelector(".pdf-scroll-inner");
    if (!scrollInner) return;
    const pageWrappers = scrollInner.children;

    for (let pIdx = 0; pIdx < pageWrappers.length; pIdx++) {
      const pageNum = pIdx + 1;
      const info = pageTextsRef.current.get(pageNum);
      if (!info) continue;
      const wrapper = pageWrappers[pIdx];
      const textLayer = wrapper.querySelector(".textLayer");
      if (!textLayer) continue;

      // Get all text spans
      const spans = Array.from(textLayer.querySelectorAll("span"))
        .filter((s) => !s.querySelector("span") && s.textContent);

      // Map character positions to spans
      let charPos = 0;
      const spanMap: Array<{ node: Text; start: number; end: number }> = [];
      for (const span of spans) {
        const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
        let textNode: Text | null;
        while ((textNode = walker.nextNode() as Text | null)) {
          const len = textNode.textContent?.length || 0;
          if (len > 0) {
            spanMap.push({ node: textNode, start: charPos, end: charPos + len });
            charPos += len;
          }
        }
      }

      // Find matches on this page and create ranges
      const lowerText = info.fullText.toLowerCase();
      let searchIdx = 0;
      let localMatchIdx = 0;
      const globalOffset = pageMatchOffsets.get(pageNum) ?? 0;

      while ((searchIdx = lowerText.indexOf(lowerQ, searchIdx)) !== -1) {
        const matchStart = searchIdx;
        const matchEnd = searchIdx + lowerQ.length;
        const globalIdx = globalOffset + localMatchIdx;

        // Find the spans covering this match
        for (const sm of spanMap) {
          const rangeStart = Math.max(matchStart, sm.start);
          const rangeEnd = Math.min(matchEnd, sm.end);
          if (rangeStart >= rangeEnd) continue;

          try {
            const range = document.createRange();
            range.setStart(sm.node, rangeStart - sm.start);
            range.setEnd(sm.node, rangeEnd - sm.start);
            allRanges.push(range);
            if (globalIdx === currentMatchIdx) {
              currentRanges.push(range);
            }
          } catch {
            /* offset out of bounds — skip */
          }
        }
        searchIdx += lowerQ.length;
        localMatchIdx++;
      }
    }

    if (allRanges.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cssHighlights.set("pdf-search", new (window as any).Highlight(...allRanges));
    }
    if (currentRanges.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cssHighlights.set("pdf-search-current", new (window as any).Highlight(...currentRanges));
    }
  }, [showSearch, searchQuery, searchMatches, currentMatchIdx, numPages]);

  // Re-apply highlights when search state or visible range changes
  useEffect(() => {
    if (highlightTimeoutRef.current) clearTimeout(highlightTimeoutRef.current);
    highlightTimeoutRef.current = setTimeout(applySearchHighlights, 150);
    return () => { if (highlightTimeoutRef.current) clearTimeout(highlightTimeoutRef.current); };
  }, [applySearchHighlights, visibleRange, renderNonce]);

  // After highlights are applied for a NEW match navigation, scroll to the
  // precise position within the page. We use a separate effect so the scroll
  // only fires when the user navigates matches, not on every visibleRange tick.
  const prevScrolledForIdx = useRef<number>(-1);
  useEffect(() => {
    if (searchMatches.length === 0 || !scrollRef.current || !pageMeta) return;
    if (prevScrolledForIdx.current === currentMatchIdx) return;
    // Wait for text layer to render & highlights to be applied, then scroll
    const timer = setTimeout(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cssHighlights = (CSS as any).highlights;
      if (!cssHighlights) return;
      const currentHL = cssHighlights.get("pdf-search-current");
      if (!currentHL || !scrollRef.current) return;
      // Get the first range from the current highlight
      const ranges = Array.from(currentHL.values()) as Range[];
      if (ranges.length === 0) return;
      const rect = ranges[0].getBoundingClientRect();
      const el = scrollRef.current;
      const containerRect = el.getBoundingClientRect();
      // Only scroll if the match is outside the visible viewport
      if (rect.top >= containerRect.top && rect.bottom <= containerRect.bottom) {
        prevScrolledForIdx.current = currentMatchIdx;
        return;
      }
      const relativeTop = rect.top - containerRect.top + el.scrollTop;
      el.scrollTop = Math.max(0, relativeTop - el.clientHeight / 2 + rect.height / 2);
      prevScrolledForIdx.current = currentMatchIdx;
    }, 200);
    return () => clearTimeout(timer);
  }, [currentMatchIdx, searchMatches, pageMeta, visibleRange]);

  // Clean up highlights when search is dismissed
  useEffect(() => {
    if (!showSearch) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (CSS as any).highlights?.delete("pdf-search");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (CSS as any).highlights?.delete("pdf-search-current");
    }
  }, [showSearch]);

  // Search navigation helpers
  const searchNext = useCallback(() => {
    if (searchMatches.length === 0) return;
    // Reset scroll tracking so the new match gets scrolled to
    lastScrolledMatchRef.current = -1;
    prevScrolledForIdx.current = -1;
    setCurrentMatchIdx((prev) => (prev + 1) % searchMatches.length);
  }, [searchMatches.length]);

  const searchPrev = useCallback(() => {
    if (searchMatches.length === 0) return;
    lastScrolledMatchRef.current = -1;
    prevScrolledForIdx.current = -1;
    setCurrentMatchIdx((prev) => (prev - 1 + searchMatches.length) % searchMatches.length);
  }, [searchMatches.length]);

  const closeSearch = useCallback(() => {
    setShowSearch(false);
    setSearchQuery("");
    setSearchMatches([]);
    setCurrentMatchIdx(0);
    lastScrolledMatchRef.current = -1;
    prevScrolledForIdx.current = -1;
  }, []);

  const scrollToPage = useCallback((page: number) => {
    if (!scrollRef.current || !pageMeta) return;
    const pageH = Math.floor(pageMeta.height * zoom) + PAGE_GAP;
    const target = (page - 1) * pageH;
    scrollRef.current.scrollTop = target;
  }, [pageMeta, zoom]);

  /* ── Escape to deactivate tool / Ctrl+S to save / Ctrl+F to search ──────── */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't intercept shortcuts when user is typing in an input/textarea
      const active = document.activeElement;
      const isTyping = active && (
        active.tagName === 'INPUT' ||
        active.tagName === 'TEXTAREA' ||
        (active as HTMLElement).isContentEditable
      );

      if (e.key === "Escape") {
        if (showSearch) { closeSearch(); return; }
        if (!isTyping) setActiveTool("none");
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        if (!showSearch) {
          setShowSearch(true);
        }
        // Always focus the search input, whether new or already open
        setTimeout(() => searchInputRef.current?.focus(), 50);
      }
      if (!isTyping && !e.shiftKey && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        savePdf();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [savePdf, showSearch, closeSearch]);

  /* ── Grab-to-pan (drag to scroll when zoomed in) ─────────────────────────── */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onPointerDown = (e: PointerEvent) => {
      // Middle-click always pans; left-click pans only with "none" tool
      // and only on the background / scroll area (not on text or annotations)
      const isMiddle = e.button === 1;
      const isLeftOnBg =
        e.button === 0 &&
        activeTool === "none" &&
        (e.target === el || (e.target as HTMLElement).classList?.contains("pdf-scroll-inner"));
      if (!isMiddle && !isLeftOnBg) return;

      e.preventDefault();
      isPanning.current = true;
      panStart.current = {
        x: e.clientX,
        y: e.clientY,
        scrollLeft: el.scrollLeft,
        scrollTop: el.scrollTop,
      };
      el.style.cursor = "grabbing";
      el.setPointerCapture(e.pointerId);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!isPanning.current) return;
      const dx = e.clientX - panStart.current.x;
      const dy = e.clientY - panStart.current.y;
      el.scrollLeft = panStart.current.scrollLeft - dx;
      el.scrollTop = panStart.current.scrollTop - dy;
    };

    const onPointerUp = (e: PointerEvent) => {
      if (!isPanning.current) return;
      isPanning.current = false;
      el.style.cursor = "";
      el.releasePointerCapture(e.pointerId);
    };

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerUp);
    return () => {
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerUp);
    };
  }, [activeTool]);

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
      // Multiplicative zoom: each unit of delta scales by ~1%
      // This gives smooth, proportional zooming at any zoom level
      setZoom((prev) => {
        const factor = Math.pow(1.01, -delta);
        return Math.min(4, Math.max(0.25, prev * factor));
      });
    };

    const handler = (e: WheelEvent) => {
      // Trackpad pinch gestures fire as wheel events with ctrlKey set
      if (!e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      // Clamp per-event delta to avoid huge jumps from discrete mouse wheels
      const clamped = Math.max(-15, Math.min(15, e.deltaY));
      pendingDelta += clamped;
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
    let firstVisible = Math.max(
      1,
      Math.floor((scrollTop - BUFFER_PX) / pageH) + 1,
    );
    const lastVisible = Math.min(
      numPages,
      Math.ceil((scrollTop + viewportH + BUFFER_PX) / pageH),
    );
    // Keep the drag-anchor page mounted so its DOM nodes stay alive
    if (activeDragAnchorPage != null) {
      firstVisible = Math.min(firstVisible, activeDragAnchorPage);
    }
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
      // Skip when hidden (display:none) — viewportH is 0 and we'd compute
      // a bogus range that replaces real pages with blank placeholders.
      if (pageH <= 0 || viewportH <= 0) return;

      // Continuously save scroll position so we can restore it when the tab
      // becomes active again after being hidden (display:none resets scrollTop).
      savedScrollTopRef.current = scrollTop;

      // Current page = which page is at the center of the viewport
      const centerY = scrollTop + viewportH / 2;
      const centerPage = Math.max(
        1,
        Math.min(numPages, Math.ceil(centerY / pageH)),
      );
      setCurrentPage(centerPage);

      let firstVisible = Math.max(
        1,
        Math.floor((scrollTop - BUFFER_PX) / pageH) + 1,
      );
      let lastVisible = Math.min(
        numPages,
        Math.ceil((scrollTop + viewportH + BUFFER_PX) / pageH),
      );
      // Keep the drag-anchor page mounted so its DOM nodes stay alive
      if (activeDragAnchorPage != null) {
        firstVisible = Math.min(firstVisible, activeDragAnchorPage);
        lastVisible = Math.max(lastVisible, activeDragAnchorPage);
      }
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
          // Restore saved scroll position after pageMeta update triggers layout
          requestAnimationFrame(() => {
            if (savedScrollTopRef.current != null && el) {
              el.scrollTop = savedScrollTopRef.current;
            }
            // Force GPU-discarded canvases to re-render
            setRenderNonce((n) => n + 1);
          });
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
        position: "relative",
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
        onPageChange={scrollToPage}
        onSearchToggle={() => { setShowSearch((s) => !s); setTimeout(() => searchInputRef.current?.focus(), 50); }}
      />

      {/* ── Toast notification ── */}
      {toastMessage && (
        <div
          style={{
            position: 'absolute',
            top: 52,
            right: 16,
            background: '#1e1e1e',
            border: '1px solid #3a3a3a',
            borderRadius: '8px',
            padding: '8px 14px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
            zIndex: 1100,
            animation: 'fadeInOut 5s ease-in-out forwards',
          }}
        >
          <span style={{ color: '#4ade80', fontSize: '12px', fontWeight: 500 }}>{toastMessage}</span>
        </div>
      )}

      {/* ── PDF Search Bar ── */}
      {showSearch && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "6px 12px",
            background: "#1e1e1e",
            borderBottom: "1px solid #2a2a2a",
            flexShrink: 0,
          }}
        >
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => { setSearchQuery(e.target.value); lastScrolledMatchRef.current = -1; prevScrolledForIdx.current = -1; }}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.shiftKey ? searchPrev() : searchNext(); e.preventDefault(); }
              if (e.key === "Escape") { closeSearch(); e.preventDefault(); }
              e.stopPropagation();
            }}
            placeholder="Find in PDF…"
            autoFocus
            className="bg-[#2a2a2a] text-[#e4e4e4] text-xs border border-[#444] rounded px-2 py-1 outline-none focus:border-[#4a9eff] w-52"
          />
          <span className="text-xs text-[#8a8a8a] select-none min-w-[60px]">
            {searchQuery
              ? searchMatches.length > 0
                ? `${currentMatchIdx + 1} of ${searchMatches.length}`
                : "No results"
              : ""}
          </span>
          <button
            type="button"
            onClick={searchPrev}
            disabled={searchMatches.length === 0}
            className="h-6 w-6 flex items-center justify-center rounded text-[#8a8a8a] hover:bg-[#2a2a2a] hover:text-[#d4d4d4] transition-colors disabled:opacity-30"
            title="Previous (Shift+Enter)"
          >
            ▲
          </button>
          <button
            type="button"
            onClick={searchNext}
            disabled={searchMatches.length === 0}
            className="h-6 w-6 flex items-center justify-center rounded text-[#8a8a8a] hover:bg-[#2a2a2a] hover:text-[#d4d4d4] transition-colors disabled:opacity-30"
            title="Next (Enter)"
          >
            ▼
          </button>
          <button
            type="button"
            onClick={closeSearch}
            className="h-6 w-6 flex items-center justify-center rounded text-[#8a8a8a] hover:bg-[#2a2a2a] hover:text-[#d4d4d4] transition-colors"
            title="Close (Escape)"
          >
            ✕
          </button>
        </div>
      )}

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
            className="pdf-scroll-inner"
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              padding: "16px",
              minHeight: "100%",
              minWidth: "fit-content",
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
            highlightColor={hlColor}
            onHighlightColorChange={setHlColor}
            onAnnotationCreated={onAnnotationCreated}
            annotations={mergedAnnotations}
            onAnnotationDeleted={onAnnotationDeleted}
          />
        )}
      </div>
    </div>
  );
};
