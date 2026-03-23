import React, { useEffect, useState, useCallback, useRef, useMemo } from "react";
import ReactDOM from "react-dom";
import { X, ChevronRight, ZoomIn, ZoomOut } from "lucide-react";

import { PDFViewer } from "./pdf/PDFViewer";
import { NotesEditor } from "./notes/NotesEditor";

// ── Simple image viewer (loads via IPC to bypass webSecurity) ─────────────────

const ImageViewer: React.FC<{ filePath: string; name: string }> = ({ filePath, name }) => {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isPanning = useRef(false);
  const panStart = useRef({ x: 0, y: 0, scrollLeft: 0, scrollTop: 0 });

  useEffect(() => {
    window.electronAPI.readFile(filePath)
      .then((bytes) => {
        const ext = filePath.split('.').pop()?.toLowerCase() || 'png';
        const mimeMap: Record<string, string> = {
          png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
          gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
        };
        const mime = mimeMap[ext] || 'image/png';
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        setSrc(`data:${mime};base64,${btoa(binary)}`);
      })
      .catch(() => setError(true));
  }, [filePath]);

  // Touchpad pinch-to-zoom — exact same mechanism as PDFViewer
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const delta = -e.deltaY * 0.01;
      setZoom(prev => Math.min(4, Math.max(0.25, prev + delta)));
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [src]);

  // Grab-to-pan — left-click drag or middle-click drag scrolls in all directions
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0 && e.button !== 1) return;
      e.preventDefault();
      isPanning.current = true;
      panStart.current = { x: e.clientX, y: e.clientY, scrollLeft: el.scrollLeft, scrollTop: el.scrollTop };
      el.style.cursor = 'grabbing';
      el.setPointerCapture(e.pointerId);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!isPanning.current) return;
      el.scrollLeft = panStart.current.scrollLeft - (e.clientX - panStart.current.x);
      el.scrollTop  = panStart.current.scrollTop  - (e.clientY - panStart.current.y);
    };

    const onPointerUp = (e: PointerEvent) => {
      if (!isPanning.current) return;
      isPanning.current = false;
      el.style.cursor = 'grab';
      el.releasePointerCapture(e.pointerId);
    };

    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerUp);
    return () => {
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointercancel', onPointerUp);
    };
  }, [src]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%' }}>
      {/* Image toolbar with zoom controls */}
      <div className="flex items-center h-10 px-3 bg-[#1e1e1e] border-b border-[#2a2a2a] gap-1 shrink-0">
        <span className="text-xs text-[#8a8a8a] select-none mr-auto truncate">{name}</span>
        <button
          type="button"
          onClick={() => setZoom(prev => Math.max(0.25, prev - 0.25))}
          className="h-8 w-8 flex items-center justify-center rounded text-[#8a8a8a] hover:bg-[#2a2a2a] hover:text-[#d4d4d4] transition-colors"
          title="Zoom Out"
        >
          <ZoomOut size={16} />
        </button>
        <span className="text-xs text-[#d4d4d4] w-12 text-center select-none">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          onClick={() => setZoom(prev => Math.min(4, prev + 0.25))}
          className="h-8 w-8 flex items-center justify-center rounded text-[#8a8a8a] hover:bg-[#2a2a2a] hover:text-[#d4d4d4] transition-colors"
          title="Zoom In"
        >
          <ZoomIn size={16} />
        </button>
      </div>
      {/* Scroll container */}
      <div
        ref={scrollRef}
        style={{ flex: 1, overflow: 'auto', background: '#141414', cursor: 'grab' }}
      >
        {error && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
            <p className="text-[#666] text-sm">Failed to load image</p>
          </div>
        )}
        {!src && !error && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
            <p className="text-[#4e4e4e] text-sm">Loading…</p>
          </div>
        )}
        {src && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100%', minWidth: 'max-content', padding: 24 }}>
            <img
              src={src}
              alt={name}
              draggable={false}
              className="select-none"
              onLoad={(e) => {
                const img = e.currentTarget;
                setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
              }}
              style={naturalSize
                ? { width: naturalSize.w * zoom, height: naturalSize.h * zoom, maxWidth: 'none' }
                : { maxWidth: '100%', maxHeight: '100%' }
              }
            />
          </div>
        )}
      </div>
    </div>
  );
};

type OpenFile = {
  filePath: string;
  fileId: string | null;
  fileType: string;
  name: string;
  initialPage?: number;
  scrollNonce?: number;
};

type TabGroup = {
  id: string;
  name: string;
  color: string;
  collapsed: boolean;
  filePaths: string[];
};

/** A visual slot: group header or individual tab */
type Slot =
  | { kind: "group"; groupId: string }
  | { kind: "tab"; filePath: string; groupId: string | null };

const GROUP_COLORS = [
  { label: "Blue", value: "#3b82f6" },
  { label: "Purple", value: "#8b5cf6" },
  { label: "Green", value: "#22c55e" },
  { label: "Red", value: "#ef4444" },
  { label: "Yellow", value: "#eab308" },
  { label: "Pink", value: "#ec4899" },
  { label: "Cyan", value: "#06b6d4" },
  { label: "Orange", value: "#f97316" },
];

type ContextMenuState = { x: number; y: number; filePath: string } | null;

type WorkspaceProps = {
  vaultPath?: string | null;
};

export const Workspace: React.FC<WorkspaceProps> = ({ vaultPath }) => {
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [dirtyFiles, setDirtyFiles] = useState<Set<string>>(new Set());
  const [tabGroups, setTabGroups] = useState<TabGroup[]>([]);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [groupNameInput, setGroupNameInput] = useState<{
    filePath: string;
    name: string;
  } | null>(null);
  const groupNameRef = useRef<HTMLInputElement>(null);

  // Portal target for rendering tab bar in the title bar
  const [tabPortalTarget, setTabPortalTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setTabPortalTarget(document.getElementById('workspace-tab-portal'));
  }, []);

  // Drag state
  const dragRef = useRef<
    | { type: "tab"; filePath: string }
    | { type: "group"; groupId: string }
    | null
  >(null);
  const [dropIndicator, setDropIndicator] = useState<string | null>(null);

  // Derived active file
  const activeIdx = openFiles.findIndex(
    (f) => f.filePath === activeFilePath,
  );
  const activeFile = activeIdx >= 0 ? openFiles[activeIdx] : null;

  const normalizePath = useCallback((p: string | null | undefined): string => {
    return (p ?? '').replace(/\\/g, '/').toLowerCase();
  }, []);

  // ── Helper: find group for a file path ─────────────────────────────────
  const getGroupForFile = useCallback(
    (fp: string) => tabGroups.find((g) => g.filePaths.includes(fp)) ?? null,
    [tabGroups],
  );

  // ── Visual tab order (includes group headers) ─────────────────────────
  const tabOrder = useMemo((): Slot[] => {
    const slots: Slot[] = [];
    const emitted = new Set<string>();
    for (const f of openFiles) {
      const grp = tabGroups.find((g) => g.filePaths.includes(f.filePath));
      if (!grp) {
        slots.push({ kind: "tab", filePath: f.filePath, groupId: null });
      } else if (!emitted.has(grp.id)) {
        emitted.add(grp.id);
        slots.push({ kind: "group", groupId: grp.id });
        if (!grp.collapsed) {
          for (const f2 of openFiles) {
            if (grp.filePaths.includes(f2.filePath)) {
              slots.push({ kind: "tab", filePath: f2.filePath, groupId: grp.id });
            }
          }
        }
      }
    }
    return slots;
  }, [openFiles, tabGroups]);

  // ── All tabs in visual order (including collapsed) for Ctrl+1-9 ───────
  const allTabsFlat = useMemo(() => {
    const result: { filePath: string; groupId: string | null }[] = [];
    const emitted = new Set<string>();
    for (const f of openFiles) {
      const grp = tabGroups.find((g) => g.filePaths.includes(f.filePath));
      if (!grp) {
        result.push({ filePath: f.filePath, groupId: null });
      } else if (!emitted.has(grp.id)) {
        emitted.add(grp.id);
        for (const f2 of openFiles) {
          if (grp.filePaths.includes(f2.filePath)) {
            result.push({ filePath: f2.filePath, groupId: grp.id });
          }
        }
      }
    }
    return result;
  }, [openFiles, tabGroups]);

  // ── Listen for openFile events from VaultSidebar ───────────────────────
  useEffect(() => {
    const handler = async (e: Event) => {
      const { filePath, fileType, page, fileId: eventFileId } = (
        e as CustomEvent<{ filePath: string; fileType: string; page?: number; fileId?: string }>
      ).detail;

      const existing = openFiles.find((f) => f.filePath === filePath);
      if (existing) {
        setActiveFilePath(filePath);
        if (page) {
          setOpenFiles((prev) =>
            prev.map((f) =>
              f.filePath === filePath
                ? { ...f, initialPage: page, scrollNonce: Date.now() }
                : f,
            ),
          );
        }
        return;
      }

      let fileId: string | null = eventFileId ?? null;
      if (!fileId && vaultPath) {
        try {
          fileId = await window.electronAPI.getFileId(vaultPath, filePath);
        } catch {
          /* ignore */
        }
      }

      const name = filePath.split(/[\\/]/).pop() ?? filePath;
      const newFile: OpenFile = { filePath, fileId, fileType, name, initialPage: page };

      setOpenFiles((prev) => [...prev, newFile]);
      setActiveFilePath(filePath);
    };

    window.addEventListener("openFile", handler as EventListener);
    return () =>
      window.removeEventListener("openFile", handler as EventListener);
  }, [vaultPath, openFiles]);

  // ── Listen for openFileToRight events ──────────────────────────────────
  useEffect(() => {
    const handler = async (e: Event) => {
      const { filePath, fileType } = (
        e as CustomEvent<{ filePath: string; fileType: string }>
      ).detail;

      // If already open, just activate
      const existing = openFiles.find((f) => f.filePath === filePath);
      if (existing) { setActiveFilePath(filePath); return; }

      let fileId: string | null = null;
      if (vaultPath) {
        try { fileId = await window.electronAPI.getFileId(vaultPath, filePath); } catch { /* ignore */ }
      }

      const name = filePath.split(/[\\/]/).pop() ?? filePath;
      const newFile: OpenFile = { filePath, fileId, fileType, name };

      setOpenFiles((prev) => {
        const activeIdx = prev.findIndex((f) => f.filePath === activeFilePath);
        if (activeIdx < 0) return [...prev, newFile];

        // Insert right after the active tab
        const next = [...prev];
        next.splice(activeIdx + 1, 0, newFile);

        // If active tab is in a group, add new file to same group
        const grp = tabGroups.find((g) => g.filePaths.includes(activeFilePath!));
        if (grp) {
          setTabGroups((gs) =>
            gs.map((g) =>
              g.id === grp.id
                ? { ...g, filePaths: [...g.filePaths, filePath] }
                : g,
            ),
          );
        }

        return next;
      });
      setActiveFilePath(filePath);
    };

    window.addEventListener("openFileToRight", handler as EventListener);
    return () =>
      window.removeEventListener("openFileToRight", handler as EventListener);
  }, [vaultPath, openFiles, activeFilePath, tabGroups]);

  // ── Listen for dirty-state changes from PDFViewer ──────────────────────
  useEffect(() => {
    const handler = (e: Event) => {
      const { filePath, dirty } = (
        e as CustomEvent<{ filePath: string; dirty: boolean }>
      ).detail;
      setDirtyFiles((prev) => {
        const next = new Set(prev);
        if (dirty) next.add(filePath);
        else next.delete(filePath);
        return next;
      });
    };
    window.addEventListener("pdfDirtyChange", handler as EventListener);
    return () =>
      window.removeEventListener("pdfDirtyChange", handler as EventListener);
  }, []);

  // ── Update open tabs when a file is moved or renamed ───────────────────
  useEffect(() => {
    const unsub = window.electronAPI.onFilePathChanged((oldPath, newPath) => {
      setOpenFiles((prev) =>
        prev.map((f) =>
          f.filePath === oldPath
            ? { ...f, filePath: newPath, name: newPath.split(/[\\/]/).pop() ?? newPath }
            : f,
        ),
      );
      setActiveFilePath((prev) => (prev === oldPath ? newPath : prev));
      setTabGroups((prev) =>
        prev.map((g) => ({
          ...g,
          filePaths: g.filePaths.map((p) => (p === oldPath ? newPath : p)),
        })),
      );
    });
    return unsub;
  }, []);

  // ── Close a tab ────────────────────────────────────────────────────────
  const closeTab = useCallback(
    (filePath: string, e?: React.MouseEvent) => {
      e?.stopPropagation();

      if (dirtyFiles.has(filePath)) {
        const confirmed = window.confirm(
          'You have unsaved annotation changes. Close without saving?',
        );
        if (!confirmed) return;
      }

      const idx = openFiles.findIndex((f) => f.filePath === filePath);
      if (idx < 0) return;

      if (filePath === activeFilePath) {
        const next = openFiles[idx + 1] ?? openFiles[idx - 1] ?? null;
        setActiveFilePath(next?.filePath ?? null);
      }

      // Steal focus away from the closing tab to prevent the renderer from losing global focus
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }

      setOpenFiles((prev) => prev.filter((f) => f.filePath !== filePath));
    },
    [openFiles, dirtyFiles, activeFilePath],
  );

  // ── Drag and drop ─────────────────────────────────────────────────────

  // ── Auto-close tab when file is deleted ───────────────────────────────
  useEffect(() => {
    const unsub = window.electronAPI.onFileDeleted((deletedPath) => {
      const normalizedDeleted = normalizePath(deletedPath);
      setOpenFiles((prev) => {
        const match = prev.find((f) => normalizePath(f.filePath) === normalizedDeleted);
        if (!match) return prev;
        return prev.filter((f) => normalizePath(f.filePath) !== normalizedDeleted);
      });
      setActiveFilePath((prev) => {
        if (normalizePath(prev) === normalizedDeleted) {
          // Pick an adjacent tab
          const idx = openFiles.findIndex((f) => normalizePath(f.filePath) === normalizedDeleted);
          const next = openFiles[idx + 1] ?? openFiles[idx - 1] ?? null;
          return next?.filePath ?? null;
        }
        return prev;
      });
      // Remove from any tab groups
      setTabGroups((prev) =>
        prev
          .map((g) => ({ ...g, filePaths: g.filePaths.filter((p) => normalizePath(p) !== normalizedDeleted) }))
          .filter((g) => g.filePaths.length > 0),
      );
    });
    return unsub;
  }, [normalizePath, openFiles]);

  // ── Cross-window sync: close md tab when saved elsewhere ───────────────
  useEffect(() => {
    const unsub = window.electronAPI.onNoteSaved((savedFilePath) => {
      const normalizedSaved = normalizePath(savedFilePath);
      setOpenFiles((prev) => {
        const file = prev.find((f) => normalizePath(f.filePath) === normalizedSaved && f.fileType === 'md');
        if (!file) return prev;
        // Close the tab
        return prev.filter((f) => normalizePath(f.filePath) !== normalizedSaved);
      });
      setActiveFilePath((prev) => {
        if (normalizePath(prev) === normalizedSaved) return null;
        return prev;
      });
    });
    return unsub;
  }, [normalizePath]);

  // ── Cross-window sync: close + reopen pdf tab when saved elsewhere ─────
  useEffect(() => {
    const unsub = window.electronAPI.onPdfFileChanged((changedPath) => {
      const normalizedChanged = normalizePath(changedPath);
      setOpenFiles((prev) => {
        const file = prev.find((f) => normalizePath(f.filePath) === normalizedChanged && f.fileType === 'pdf');
        if (!file) return prev;
        // Replace with a new object to force remount (fresh load)
        return prev.map((f) =>
          normalizePath(f.filePath) === normalizedChanged
            ? { ...f, scrollNonce: Date.now() }
            : f
        );
      });
    });
    return unsub;
  }, [normalizePath]);

  // ── Cross-window sync: refresh pdf tab when annotations saved elsewhere ──
  useEffect(() => {
    const unsub = window.electronAPI.onAnnotationsSaved((savedPath) => {
      const normalizedSaved = normalizePath(savedPath);
      setOpenFiles((prev) => {
        const file = prev.find((f) => f.fileType === 'pdf' && normalizePath(f.filePath) === normalizedSaved);
        if (!file) return prev;
        return prev.map((f) =>
          f.fileType === 'pdf' && normalizePath(f.filePath) === normalizedSaved
            ? { ...f, scrollNonce: Date.now() }
            : f,
        );
      });
    });
    return unsub;
  }, [normalizePath]);

  const handleDragStart = useCallback(
    (e: React.DragEvent, type: "tab" | "group", id: string) => {
      dragRef.current =
        type === "tab"
          ? { type: "tab", filePath: id }
          : { type: "group", groupId: id };
      e.dataTransfer.effectAllowed = "move";
      const el = e.currentTarget as HTMLElement;
      e.dataTransfer.setDragImage(el, el.offsetWidth / 2, el.offsetHeight / 2);
    },
    [],
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent, slotKey: string) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDropIndicator(slotKey);
    },
    [],
  );

  const handleDragEnd = useCallback(() => {
    dragRef.current = null;
    setDropIndicator(null);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent, targetKey: string) => {
      e.preventDefault();
      const drag = dragRef.current;
      dragRef.current = null;
      setDropIndicator(null);
      if (!drag) return;

      // ── Drop at end (trailing zone) ──
      if (targetKey === "__END__") {
        if (drag.type === "tab") {
          const srcPath = drag.filePath;
          setOpenFiles((prev) => {
            const without = prev.filter((f) => f.filePath !== srcPath);
            const tab = prev.find((f) => f.filePath === srcPath);
            return tab ? [...without, tab] : prev;
          });
          // Remove from group since it now has no group neighbors at end
          setTabGroups((prev) => {
            const updated = prev.map((g) => ({
              ...g,
              filePaths: g.filePaths.filter((fp) => fp !== srcPath),
            }));
            // Re-check: if right neighbor is same group we keep it, but at __END__ there's no right neighbor
            // Left neighbor check happens after setOpenFiles settles — just remove unconditionally here
            return updated.filter((g) => g.filePaths.length > 0);
          });
        } else {
          // Move whole group to end
          const grp = tabGroups.find((g) => g.id === drag.groupId);
          if (!grp) return;
          const groupSet = new Set(grp.filePaths);
          setOpenFiles((prev) => [
            ...prev.filter((f) => !groupSet.has(f.filePath)),
            ...prev.filter((f) => groupSet.has(f.filePath)),
          ]);
        }
        return;
      }

      if (drag.type === "tab") {
        // ── Dropping a single tab ──
        const srcPath = drag.filePath;
        const targetIsGroup = tabGroups.some((g) => g.id === targetKey);

        let targetPath: string | null = null;
        if (targetIsGroup) {
          const grp = tabGroups.find((g) => g.id === targetKey)!;
          const first = openFiles.find((f) =>
            grp.filePaths.includes(f.filePath),
          );
          targetPath = first?.filePath ?? null;
        } else {
          targetPath = targetKey;
        }

        if (!targetPath || srcPath === targetPath) return;

        const srcIdx = openFiles.findIndex((f) => f.filePath === srcPath);
        const tgtIdx = openFiles.findIndex((f) => f.filePath === targetPath);
        if (srcIdx < 0 || tgtIdx < 0) return;

        // Compute new openFiles order
        const newOrder = [...openFiles];
        const [moved] = newOrder.splice(srcIdx, 1);
        const adjustedTgt = srcIdx < tgtIdx ? tgtIdx - 1 : tgtIdx;
        newOrder.splice(adjustedTgt, 0, moved);
        setOpenFiles(newOrder);

        // Auto-group / ungroup based on neighbors
        const newIdx = adjustedTgt;
        const leftPath =
          newIdx > 0 ? newOrder[newIdx - 1].filePath : null;
        const rightPath =
          newIdx < newOrder.length - 1
            ? newOrder[newIdx + 1].filePath
            : null;
        const leftGrp = leftPath
          ? tabGroups.find((g) => g.filePaths.includes(leftPath))
          : null;
        const rightGrp = rightPath
          ? tabGroups.find((g) => g.filePaths.includes(rightPath))
          : null;
        const curGrp = tabGroups.find((g) =>
          g.filePaths.includes(srcPath),
        );

        let targetGroup: TabGroup | null = null;
        if (leftGrp && rightGrp && leftGrp.id === rightGrp.id) {
          targetGroup = leftGrp;
        } else if (leftGrp && curGrp && leftGrp.id === curGrp.id) {
          targetGroup = curGrp;
        } else if (rightGrp && curGrp && rightGrp.id === curGrp.id) {
          targetGroup = curGrp;
        }

        if (targetGroup?.id !== curGrp?.id) {
          setTabGroups((prev) => {
            let updated = [...prev];
            if (curGrp) {
              updated = updated
                .map((g) =>
                  g.id === curGrp.id
                    ? {
                        ...g,
                        filePaths: g.filePaths.filter(
                          (fp) => fp !== srcPath,
                        ),
                      }
                    : g,
                )
                .filter((g) => g.filePaths.length > 0);
            }
            if (targetGroup) {
              updated = updated.map((g) =>
                g.id === targetGroup!.id
                  ? { ...g, filePaths: [...g.filePaths, srcPath] }
                  : g,
              );
            }
            return updated;
          });
        }
      } else {
        // ── Dropping a group ──
        const grp = tabGroups.find((g) => g.id === drag.groupId);
        if (!grp) return;

        const targetIsGroup = tabGroups.some((g) => g.id === targetKey);
        if (targetIsGroup && targetKey === drag.groupId) return;
        if (!targetIsGroup && grp.filePaths.includes(targetKey)) return;

        const groupSet = new Set(grp.filePaths);
        const rest = openFiles.filter((f) => !groupSet.has(f.filePath));
        const groupTabs = openFiles.filter((f) =>
          groupSet.has(f.filePath),
        );

        let insertIdx: number;
        if (targetIsGroup) {
          const tGrp = tabGroups.find((g) => g.id === targetKey)!;
          insertIdx = rest.findIndex((f) =>
            tGrp.filePaths.includes(f.filePath),
          );
        } else {
          insertIdx = rest.findIndex((f) => f.filePath === targetKey);
        }
        if (insertIdx < 0) insertIdx = rest.length;

        setOpenFiles([
          ...rest.slice(0, insertIdx),
          ...groupTabs,
          ...rest.slice(insertIdx),
        ]);
      }
    },
    [openFiles, tabGroups],
  );

  // ── Context menu for tabs ──────────────────────────────────────────────
  const handleTabContextMenu = useCallback(
    (e: React.MouseEvent, filePath: string) => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({ x: e.clientX, y: e.clientY, filePath });
    },
    [],
  );

  useEffect(() => {
    if (!contextMenu) return;
    const handler = () => setContextMenu(null);
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [contextMenu]);

  useEffect(() => {
    if (groupNameInput) groupNameRef.current?.focus();
  }, [groupNameInput]);

  // ── Tab group helpers ──────────────────────────────────────────────────
  const nextGroupColor = useCallback(() => {
    const used = new Set(tabGroups.map((g) => g.color));
    return (
      GROUP_COLORS.find((c) => !used.has(c.value))?.value ??
      GROUP_COLORS[0].value
    );
  }, [tabGroups]);

  const addToNewGroup = useCallback((filePath: string) => {
    setGroupNameInput({ filePath, name: "" });
    setContextMenu(null);
  }, []);

  const addToExistingGroup = useCallback(
    (filePath: string, groupId: string) => {
      setTabGroups((prev) =>
        prev
          .map((g) => ({
            ...g,
            filePaths: g.filePaths.filter((fp) => fp !== filePath),
          }))
          .map((g) =>
            g.id === groupId
              ? { ...g, filePaths: [...g.filePaths, filePath] }
              : g,
          )
          .filter((g) => g.filePaths.length > 0),
      );

      // Move the tab to be adjacent to the group in openFiles
      const grp = tabGroups.find((g) => g.id === groupId);
      if (grp && grp.filePaths.length > 0) {
        setOpenFiles((prev) => {
          const theFile = prev.find((f) => f.filePath === filePath);
          if (!theFile) return prev;
          const filtered = prev.filter((f) => f.filePath !== filePath);
          // Find last consecutive group member index
          let lastIdx = -1;
          for (let i = 0; i < filtered.length; i++) {
            if (grp.filePaths.includes(filtered[i].filePath)) lastIdx = i;
          }
          const insertPos = lastIdx >= 0 ? lastIdx + 1 : filtered.length;
          return [
            ...filtered.slice(0, insertPos),
            theFile,
            ...filtered.slice(insertPos),
          ];
        });
      }

      setContextMenu(null);
    },
    [tabGroups],
  );

  const removeFromGroup = useCallback((filePath: string) => {
    setTabGroups((prev) => {
      const updated = prev.map((g) => ({
        ...g,
        filePaths: g.filePaths.filter((fp) => fp !== filePath),
      }));
      return updated.filter((g) => g.filePaths.length > 0);
    });
    setContextMenu(null);
  }, []);

  const confirmNewGroup = useCallback(() => {
    if (!groupNameInput || !groupNameInput.name.trim()) {
      setGroupNameInput(null);
      return;
    }
    const filePath = groupNameInput.filePath;
    const file = openFiles.find((f) => f.filePath === filePath);
    if (!file) {
      setGroupNameInput(null);
      return;
    }

    setTabGroups((prev) => {
      const cleaned = prev
        .map((g) => ({
          ...g,
          filePaths: g.filePaths.filter((fp) => fp !== filePath),
        }))
        .filter((g) => g.filePaths.length > 0);

      return [
        ...cleaned,
        {
          id: `grp-${Date.now()}`,
          name: groupNameInput.name.trim(),
          color: nextGroupColor(),
          collapsed: false,
          filePaths: [filePath],
        },
      ];
    });
    setGroupNameInput(null);
  }, [groupNameInput, openFiles, nextGroupColor]);

  const toggleGroupCollapse = useCallback((groupId: string) => {
    setTabGroups((prev) =>
      prev.map((g) =>
        g.id === groupId ? { ...g, collapsed: !g.collapsed } : g,
      ),
    );
  }, []);

  const ungroupAll = useCallback((groupId: string) => {
    setTabGroups((prev) => prev.filter((g) => g.id !== groupId));
    setContextMenu(null);
  }, []);

  // Clean up groups when tabs are closed
  useEffect(() => {
    const paths = new Set(openFiles.map((f) => f.filePath));
    setTabGroups((prev) => {
      const updated = prev.map((g) => ({
        ...g,
        filePaths: g.filePaths.filter((fp) => paths.has(fp)),
      }));
      return updated.filter((g) => g.filePaths.length > 0);
    });
  }, [openFiles]);

  // ── Ctrl+W to close current tab ───────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "w") {
        e.preventDefault();
        if (activeFilePath) closeTab(activeFilePath);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeFilePath, closeTab]);

  // ── Ctrl+1-9 for tab switching ────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const num = parseInt(e.key);
      if (isNaN(num) || num < 1 || num > 9) return;
      e.preventDefault();

      const target = allTabsFlat[num - 1];
      if (!target) return;

      // Expand group if collapsed
      if (target.groupId) {
        const grp = tabGroups.find((g) => g.id === target.groupId);
        if (grp?.collapsed) {
          setTabGroups((prev) =>
            prev.map((g) =>
              g.id === target.groupId ? { ...g, collapsed: false } : g,
            ),
          );
        }
      }

      setActiveFilePath(target.filePath);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [allTabsFlat, tabGroups]);

  // ── Render all open files (hide inactive ones to preserve state) ────────
  const renderAllFiles = () => {
    if (openFiles.length === 0) {
      return (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-[#4e4e4e] text-sm select-none">
            Open a file from the vault to get started
          </p>
        </div>
      );
    }

    return (
      <>
        {openFiles.map((f) => {
          const isActive = f.filePath === activeFilePath;

          if (f.fileType === "pdf") {
            return (
              <div
                key={f.filePath}
                className="flex-1 min-h-0 overflow-hidden"
                style={{ display: isActive ? undefined : 'none' }}
              >
                <PDFViewer
                  filePath={f.filePath}
                  fileId={f.fileId ?? ""}
                  vaultPath={vaultPath}
                  initialPage={f.initialPage}
                  scrollNonce={f.scrollNonce}
                  isActive={isActive}
                />
              </div>
            );
          }

          if (f.fileType === "md") {
            return (
              <div
                key={f.filePath}
                className="flex-1 min-h-0 overflow-hidden"
                style={{ display: isActive ? undefined : 'none' }}
              >
                <NotesEditor
                  filePath={f.filePath}
                  noteId={f.fileId ?? ""}
                  vaultPath={vaultPath ?? ""}
                />
              </div>
            );
          }

          if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(f.fileType)) {
            return (
              <div
                key={f.filePath}
                className="flex-1 min-h-0 overflow-hidden"
                style={{ display: isActive ? undefined : 'none' }}
              >
                <ImageViewer filePath={f.filePath} name={f.name} />
              </div>
            );
          }

          return (
            <div
              key={f.filePath}
              className="flex-1 flex items-center justify-center"
              style={{ display: isActive ? undefined : 'none' }}
            >
              <p className="text-[#4e4e4e] text-sm select-none">
                {f.name} — unsupported file type
              </p>
            </div>
          );
        })}
        {/* Show placeholder if no active file selected */}
        {!activeFile && (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-[#4e4e4e] text-sm select-none">
              Open a file from the vault to get started
            </p>
          </div>
        )}
      </>
    );
  };

  const tabColor = (ft: string) => {
    if (ft === "pdf") return "bg-red-500";
    if (ft === "md") return "bg-blue-400";
    return "bg-gray-400";
  };

  return (
    <section className="h-full w-full flex flex-col overflow-hidden">
      {/* ── Tab bar (rendered in title bar via portal) ── */}
      {openFiles.length > 0 && tabPortalTarget && ReactDOM.createPortal(
        <div
          className="flex items-stretch overflow-hidden w-full h-full"
        >
          {tabOrder.map((slot) => {
            if (slot.kind === "group") {

              const g = tabGroups.find((grp) => grp.id === slot.groupId)!;
              if (!g) return null;
              return (
                <div
                  key={`gh-${g.id}`}
                  className="flex items-center shrink-0"
                  style={{ borderBottom: `2px solid ${g.color}` }}
                  draggable
                  onDragStart={(e) => handleDragStart(e, "group", g.id)}
                  onDragOver={(e) => handleDragOver(e, g.id)}
                  onDrop={(e) => handleDrop(e, g.id)}
                  onDragEnd={handleDragEnd}
                >
                  <button
                    type="button"
                    onClick={() => toggleGroupCollapse(g.id)}
                    className="flex items-center gap-1 px-2 h-full text-[10px] font-semibold hover:bg-[#2a2a2a] transition-colors"
                    style={{
                      color: g.color,
                      cursor: "grab",
                      borderLeft:
                        dropIndicator === g.id
                          ? "2px solid #6366f1"
                          : "2px solid transparent",
                    }}
                    title={g.collapsed ? "Expand group" : "Collapse group"}
                  >
                    <ChevronRight
                      size={10}
                      style={{
                        transform: g.collapsed
                          ? "rotate(0deg)"
                          : "rotate(90deg)",
                        transition: "transform 150ms ease",
                      }}
                    />
                    {g.name}
                    {g.collapsed && (
                      <span className="text-[9px] text-[#6e6e6e] ml-0.5">
                        {g.filePaths.length}
                      </span>
                    )}
                  </button>
                </div>
              );
            }

            const f = openFiles.find((o) => o.filePath === slot.filePath);
            if (!f) return null;
            const grp = slot.groupId
              ? tabGroups.find((g) => g.id === slot.groupId)
              : null;
            const isActive = f.filePath === activeFilePath;

            return (
              <button
                key={f.filePath}
                type="button"
                draggable
                onClick={() => setActiveFilePath(f.filePath)}
                onContextMenu={(e) => handleTabContextMenu(e, f.filePath)}
                onDragStart={(e) => handleDragStart(e, "tab", f.filePath)}
                onDragOver={(e) => handleDragOver(e, f.filePath)}
                onDrop={(e) => handleDrop(e, f.filePath)}
                onDragEnd={handleDragEnd}
                className={`group flex items-center gap-1.5 px-3 text-xs border-r border-[#2a2a2a] overflow-hidden transition-all ${
                  isActive
                    ? "bg-[#1e1e1e] text-[#e4e4e4]"
                    : "text-[#6e6e6e] hover:bg-[#222] hover:text-[#aaa]"
                }`}
                style={{
                  flex: "1 1 0",
                  minWidth: "80px",
                  maxWidth: "200px",
                  cursor: "grab",
                  borderLeft:
                    dropIndicator === f.filePath
                      ? "2px solid #6366f1"
                      : "2px solid transparent",
                  opacity:
                    dragRef.current?.type === "tab" &&
                    dragRef.current.filePath === f.filePath
                      ? 0.5
                      : 1,
                  borderBottom: grp
                    ? `2px solid ${grp.color}`
                    : "2px solid transparent",
                }}
              >
                <span
                  className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${tabColor(f.fileType)}`}
                />
                <span className="truncate">{f.name}</span>
                {dirtyFiles.has(f.filePath) && (
                  <span
                    className="flex-shrink-0"
                    style={{
                      display: "inline-block",
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: "#ffffff",
                      marginLeft: 4,
                    }}
                    title="Unsaved changes"
                  />
                )}
                <span
                  onClick={(e) => closeTab(f.filePath, e)}
                  className="ml-auto flex-shrink-0 rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-[#3a3a3a] transition-opacity"
                  title="Close tab"
                >
                  <X size={12} />
                </span>
              </button>
            );
          })}
          {/* Trailing drop zone — allows dropping after the last tab */}
          <div
            style={{
              flex: "1 1 auto",
              minWidth: 24,
              borderLeft:
                dropIndicator === "__END__"
                  ? "2px solid #6366f1"
                  : "2px solid transparent",
            }}
            onDragOver={(e) => handleDragOver(e, "__END__")}
            onDrop={(e) => handleDrop(e, "__END__")}
          />
        </div>,
        tabPortalTarget,
      )}

      {/* ── Context menu ── */}
      {contextMenu &&
        (() => {
          const cmGroup = getGroupForFile(contextMenu.filePath);
          return (
            <div
              style={{
                position: "fixed",
                top: contextMenu.y,
                left: contextMenu.x,
                zIndex: 1000,
                background: "#2d2d2d",
                border: "1px solid #444",
                borderRadius: "8px",
                padding: "4px 0",
                minWidth: "200px",
                boxShadow: "0 8px 24px rgba(0,0,0,0.6)",
              }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                className="w-full text-left px-3 py-1.5 text-xs text-[#ccc] hover:bg-[#3a3a3a] transition-colors"
                onClick={() => addToNewGroup(contextMenu.filePath)}
              >
                Add to new group…
              </button>
              {tabGroups.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  className="w-full text-left px-3 py-1.5 text-xs text-[#ccc] hover:bg-[#3a3a3a] transition-colors flex items-center gap-2"
                  onClick={() =>
                    addToExistingGroup(contextMenu.filePath, g.id)
                  }
                >
                  <span
                    style={{ background: g.color }}
                    className="inline-block w-2.5 h-2.5 rounded-sm"
                  />
                  Add to &quot;{g.name}&quot;
                </button>
              ))}
              {cmGroup && (
                <>
                  <div className="h-px bg-[#444] my-1" />
                  <button
                    type="button"
                    className="w-full text-left px-3 py-1.5 text-xs text-[#ccc] hover:bg-[#3a3a3a] transition-colors"
                    onClick={() => removeFromGroup(contextMenu.filePath)}
                  >
                    Remove from group
                  </button>
                  <button
                    type="button"
                    className="w-full text-left px-3 py-1.5 text-xs text-[#f87171] hover:bg-[#3a3a3a] transition-colors"
                    onClick={() => ungroupAll(cmGroup.id)}
                  >
                    Ungroup all
                  </button>
                </>
              )}
              <div className="h-px bg-[#444] my-1" />
              <button
                type="button"
                className="w-full text-left px-3 py-1.5 text-xs text-[#ccc] hover:bg-[#3a3a3a] transition-colors"
                onClick={() => {
                  closeTab(contextMenu.filePath);
                  setContextMenu(null);
                }}
              >
                Close tab
              </button>
            </div>
          );
        })()}

      {/* ── New group name input popup ── */}
      {groupNameInput && (
        <div
          style={{
            position: "fixed",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            zIndex: 1001,
            background: "#2d2d2d",
            border: "1px solid #444",
            borderRadius: "10px",
            padding: "16px",
            minWidth: "260px",
            boxShadow: "0 12px 32px rgba(0,0,0,0.7)",
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="text-xs text-[#aaa] mb-2">Group name</div>
          <input
            ref={groupNameRef}
            value={groupNameInput.name}
            onChange={(e) =>
              setGroupNameInput((prev) =>
                prev ? { ...prev, name: e.target.value } : prev,
              )
            }
            onKeyDown={(e) => {
              if (e.key === "Enter") confirmNewGroup();
              if (e.key === "Escape") setGroupNameInput(null);
            }}
            className="w-full bg-[#1e1e1e] border border-[#444] rounded-md px-3 py-1.5 text-sm text-[#d4d4d4] outline-none focus:border-[#6366f1]"
            placeholder="e.g. Research, Notes…"
          />
          <div className="flex justify-end gap-2 mt-3">
            <button
              type="button"
              onClick={() => setGroupNameInput(null)}
              className="text-xs text-[#888] hover:text-[#ccc] px-2 py-1"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirmNewGroup}
              className="text-xs bg-[#6366f1] text-white px-3 py-1 rounded hover:bg-[#5558e6]"
            >
              Create
            </button>
          </div>
        </div>
      )}

      {renderAllFiles()}
    </section>
  );
};
