import React, { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { X, ChevronRight } from "lucide-react";

import { PDFViewer } from "./pdf/PDFViewer";
import { NotesEditor } from "./notes/NotesEditor";

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
      const { filePath, fileType, page } = (
        e as CustomEvent<{ filePath: string; fileType: string; page?: number }>
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

      let fileId: string | null = null;
      if (vaultPath) {
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

      setOpenFiles((prev) => prev.filter((f) => f.filePath !== filePath));
    },
    [openFiles, dirtyFiles, activeFilePath],
  );

  // ── Drag and drop ─────────────────────────────────────────────────────
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
      {/* ── Tab bar ── */}
      {openFiles.length > 0 && (
        <div
          style={{
            height: "36px",
            background: "#181818",
            borderBottom: "1px solid #2a2a2a",
            flexShrink: 0,
          }}
          className="flex items-stretch overflow-x-auto"
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
                className={`group flex items-center gap-1.5 px-3 text-xs border-r border-[#2a2a2a] whitespace-nowrap transition-all ${
                  isActive
                    ? "bg-[#1e1e1e] text-[#e4e4e4]"
                    : "text-[#6e6e6e] hover:bg-[#222] hover:text-[#aaa]"
                }`}
                style={{
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
        </div>
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
