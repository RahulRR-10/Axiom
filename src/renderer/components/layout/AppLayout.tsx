import React, { useState, useCallback, useEffect, useRef } from "react";

import { Search } from "lucide-react";
import { AIPanel } from "../ai/AIPanel";
import type { SearchResult } from "../../../shared/types";
import { SearchPanel } from "../search/SearchPanel";
import { VaultSidebar } from "../vault/VaultSidebar";
import { Workspace } from "../workspace/Workspace";
import { WindowControlsToolbar } from "./WindowControlsToolbar";

const AI_MIN_WIDTH = 200;
const AI_MAX_WIDTH = 700;

export const AppLayout: React.FC = () => {
  const [vaultCollapsed, setVaultCollapsed] = useState<boolean>(false);
  const [aiCollapsed, setAiCollapsed] = useState<boolean>(false);
  const [vaultPath, setVaultPath] = useState<string | null>(null);
  const [aiWidth, setAiWidth] = useState<number>(340);
  const [updateReady, setUpdateReady] = useState<boolean>(false);
  const [isResizingAI, setIsResizingAI] = useState<boolean>(false);
  const [aiQuestion, setAiQuestion] = useState<string>('');
  const [aiSources, setAiSources] = useState<SearchResult[]>([]);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const isDraggingAI = useRef<boolean>(false);
  const dragStartX = useRef<number>(0);
  const dragStartW = useRef<number>(340);

  const searchInputRef = useRef<HTMLInputElement>(null);

  const onAIResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDraggingAI.current = true;
      setIsResizingAI(true);
      dragStartX.current = e.clientX;
      dragStartW.current = aiWidth;

      const onMouseMove = (ev: MouseEvent): void => {
        if (!isDraggingAI.current) return;
        const delta = dragStartX.current - ev.clientX;
        const newW = Math.min(
          AI_MAX_WIDTH,
          Math.max(AI_MIN_WIDTH, dragStartW.current + delta),
        );
        setAiWidth(newW);
      };

      const onMouseUp = (): void => {
        isDraggingAI.current = false;
        setIsResizingAI(false);
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
      };

      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    },
    [aiWidth],
  );

  const handleOpenNewVault = useCallback(() => {
    window.dispatchEvent(new CustomEvent("triggerOpenVault"));
  }, []);

  /* ── Auto-updater: listen for downloaded update ── */
  useEffect(() => window.electronAPI.onUpdateDownloaded(() => setUpdateReady(true)), []);

  /* ── sendToAI → auto-expand AI panel ── */
  useEffect(() => {
    const handler = (): void => setAiCollapsed(false);
    window.addEventListener('sendToAI', handler);
    return () => window.removeEventListener('sendToAI', handler);
  }, []);

  /* ── Ctrl+K → focus search ── */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInputRef.current?.focus();
        window.dispatchEvent(new CustomEvent("spotlight:open"));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const noDragStyle = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

  return (
    <div className="h-screen w-screen overflow-hidden flex flex-col bg-[#141414] text-[#d4d4d4]">
      {/* ── Update-ready banner ── */}
      {updateReady && (
        <div className="shrink-0 flex items-center justify-between px-4 py-1.5 bg-[#1a3a2a] border-b border-[#2a5a3a] text-xs text-[#7fcf9f]">
          <span>A new version of Axiom has been downloaded and is ready to install.</span>
          <div className="flex items-center gap-2 ml-4">
            <button
              type="button"
              onClick={() => void window.electronAPI.installAndRestart()}
              className="px-2.5 py-1 rounded bg-[#2a6a4a] hover:bg-[#3a7a5a] text-[#a0dfbf] font-medium transition-colors"
            >
              Restart &amp; Update
            </button>
            <button
              type="button"
              onClick={() => setUpdateReady(false)}
              className="px-2.5 py-1 rounded hover:bg-[#2a4a3a] text-[#7fcf9f] transition-colors"
            >
              Later
            </button>
          </div>
        </div>
      )}
      {/* ── Global title bar ── search, Axiom, settings, window controls */}
      <header
        style={
          {
            background: "#1a1a1a",
            borderBottom: "1px solid #2a2a2a",
            WebkitAppRegion: "drag",
          } as React.CSSProperties
        }
        className="h-10 shrink-0 w-full flex items-center px-4 relative"
      >
        {/* Left: Axiom branding */}
        <div className="flex items-center gap-1.5 text-xs text-[#8a8a8a] shrink-0 mr-4 select-none">
          <img src={new URL('axiom-logo.png', window.location.href).href} alt="" className="w-4 h-4 object-contain" />
          Axiom
        </div>

        {/* Center: Search bar — absolute so it's perfectly centered */}
        <div
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-[400px] px-4"
          style={noDragStyle}
        >
          <div className="relative">
            <Search
              size={14}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#5a5a5a] pointer-events-none"
            />
            <input
              ref={searchInputRef}
              placeholder="Search your vault... (Ctrl+K)"
              onClick={() =>
                window.dispatchEvent(new CustomEvent("spotlight:open"))
              }
              readOnly
              className="w-full rounded-md bg-[#141414] border border-[#2a2a2a] pl-8 pr-3 py-1.5 text-sm text-[#d4d4d4] outline-none focus:border-[#3a3a3a] cursor-pointer"
            />
          </div>
        </div>

        {/* Spacer to push right section */}
        <div className="flex-1" />

        {/* Right: window controls */}
        <div className="flex items-center shrink-0 ml-4" style={noDragStyle}>
          <WindowControlsToolbar />
        </div>
      </header>

      {/* ── Three-panel row ── fills remaining height */}
      <div className="flex flex-1 min-h-0 overflow-hidden" style={{ position: 'relative' }}>
        {/* Drag overlay — blocks webviews/iframes from swallowing mouse events */}
        {isResizingAI && (
          <div style={{ position: 'absolute', inset: 0, zIndex: 9999, cursor: 'col-resize' }} />
        )}
        {/* Vault sidebar */}
        <section
          style={{
            width: vaultCollapsed ? "36px" : "240px",
            transition: "width 200ms ease-in-out",
            background: "#1e1e1e",
            borderRight: "1px solid #2a2a2a",
          }}
          className="h-full overflow-hidden shrink-0 flex flex-col"
        >
          {/* Header — always shown */}
          {vaultCollapsed ? (
            <div className="h-10 border-b border-[#2a2a2a] flex items-center justify-center shrink-0">
              <button
                type="button"
                onClick={() => setVaultCollapsed(false)}
                className="h-8 w-8 rounded-md text-[#d4d4d4] hover:bg-[#2a2a2a] flex items-center justify-center"
                aria-label="Expand vault sidebar"
              >
                ⊞
              </button>
            </div>
          ) : (
            <div className="h-10 border-b border-[#2a2a2a] flex items-center justify-between px-2 shrink-0">
              <span className="text-xs text-[#8a8a8a]">Vault</span>
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={handleOpenNewVault}
                  className="h-7 w-7 rounded-md text-[#8a8a8a] hover:text-[#d4d4d4] hover:bg-[#2a2a2a] flex items-center justify-center"
                  aria-label="Open vault folder"
                  title="Open / switch vault"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
                    <line x1="12" y1="10" x2="12" y2="16" />
                    <line x1="9" y1="13" x2="15" y2="13" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={() => setVaultCollapsed(true)}
                  className="h-7 w-7 rounded-md text-[#8a8a8a] hover:text-[#d4d4d4] hover:bg-[#2a2a2a] flex items-center justify-center"
                  aria-label="Collapse vault sidebar"
                >
                  ←
                </button>
              </div>
            </div>
          )}
          {/* Sidebar content — always mounted, hidden when collapsed */}
          <div
            className="flex-1 overflow-hidden"
            style={{ display: vaultCollapsed ? "none" : "block" }}
          >
            <VaultSidebar onVaultOpen={setVaultPath} />
          </div>
        </section>

        {/* Workspace */}
        <main
          style={{
            background: "#141414",
            borderRight: "1px solid #2a2a2a",
          }}
          className="h-full overflow-hidden flex-1 min-w-0"
        >
          <Workspace vaultPath={vaultPath} />
        </main>

        {/* AI panel */}
        <section
          style={{
            width: aiCollapsed ? "36px" : `${aiWidth}px`,
            transition: isResizingAI ? "none" : "width 200ms ease-in-out",
            background: "#1e1e1e",
            position: "relative",
          }}
          className="h-full overflow-hidden shrink-0 flex flex-col"
        >
          {/* Resize handle */}
          {!aiCollapsed && (
            <div
              onMouseDown={onAIResizeMouseDown}
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                bottom: 0,
                width: "4px",
                cursor: "col-resize",
                zIndex: 10,
              }}
              className="hover:bg-[#4a9eff]/40"
            />
          )}
          {aiCollapsed && (
            <div className="h-full w-full flex flex-col">
              <div className="h-10 border-b border-[#2a2a2a] flex items-center justify-center">
                <button
                  type="button"
                  onClick={() => setAiCollapsed(false)}
                  className="h-8 w-8 rounded-md text-[#d4d4d4] hover:bg-[#2a2a2a]"
                  aria-label="Expand AI panel"
                >
                  ◧
                </button>
              </div>
            </div>
          )}
          <div className="h-full w-full flex flex-col overflow-hidden" style={{ display: aiCollapsed ? "none" : "flex" }}>
            <div className="h-10 border-b border-[#2a2a2a] flex items-center px-2 gap-1.5">
              <span className="text-xs text-[#8a8a8a] shrink-0">AI</span>
              <input
                value={aiQuestion}
                onChange={(e) => setAiQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && aiQuestion.trim() && vaultPath) {
                    window.dispatchEvent(new CustomEvent('ai:ask', { detail: { question: aiQuestion } }));
                    setAiQuestion('');
                  }
                }}
                placeholder="Ask your study material..."
                disabled={!vaultPath}
                className="flex-1 bg-[#141414] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-[#d4d4d4] outline-none placeholder-[#4a4a4a] focus:border-[#4a9eff] disabled:opacity-50 min-w-0"
              />
              <button
                type="button"
                onClick={() => {
                  if (aiQuestion.trim() && vaultPath) {
                    window.dispatchEvent(new CustomEvent('ai:ask', { detail: { question: aiQuestion } }));
                    setAiQuestion('');
                  }
                }}
                disabled={!aiQuestion.trim() || !vaultPath}
                className="shrink-0 px-2 py-1 rounded text-xs font-medium bg-[#4a9eff] text-white hover:bg-[#3a8eff] disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Ask
              </button>
              <button
                type="button"
                onClick={() => aiSources.length > 0 && setSourcesOpen((v) => !v)}
                disabled={aiSources.length === 0}
                className={`shrink-0 px-2 py-1 rounded text-xs font-medium transition-colors ${
                  aiSources.length > 0
                    ? "text-[#8a8a8a] hover:text-[#ccc] hover:bg-[#2a2a2a] cursor-pointer"
                    : "text-[#3a3a3a] cursor-default"
                }`}
                title={aiSources.length > 0 ? "Toggle sources" : "No sources yet"}
              >
                Sources{aiSources.length > 0 ? ` (${aiSources.length})` : ""}
              </button>
              <button
                type="button"
                onClick={() => setAiCollapsed(true)}
                className="h-7 w-7 rounded-md text-[#d4d4d4] hover:bg-[#2a2a2a] flex items-center justify-center shrink-0"
                aria-label="Collapse AI panel"
              >
                →
              </button>
            </div>
            {/* Sources panel */}
            {sourcesOpen && aiSources.length > 0 && (
              <div
                className="shrink-0 border-b border-[#2a2a2a] bg-[#1a1a1a]"
                style={{ maxHeight: 180, overflowY: "auto" }}
              >
                {aiSources.map((source) => {
                  const isExpanded = expandedIds.has(source.id);
                  return (
                    <div key={source.id} className="px-2 py-1">
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          className="text-[10px] text-[#6a6a6a] hover:text-[#aaa] w-4 text-center shrink-0"
                          onClick={() => {
                            setExpandedIds((prev) => {
                              const next = new Set(prev);
                              isExpanded ? next.delete(source.id) : next.add(source.id);
                              return next;
                            });
                          }}
                        >
                          {isExpanded ? "▼" : "▶"}
                        </button>
                        <span className="text-[11px] text-[#bbb] truncate flex-1">
                          {source.file_name}
                          {source.page_or_slide != null ? ` — Page ${source.page_or_slide}` : ""}
                        </span>
                        <button
                          type="button"
                          className="text-[10px] text-[#5a5a5a] hover:text-[#aaa] shrink-0 px-1"
                          onClick={() => {
                            window.dispatchEvent(
                              new CustomEvent("openFile", {
                                detail: {
                                  filePath: source.file_path,
                                  fileId: source.file_id,
                                  fileType: source.file_type,
                                  page: source.page_or_slide,
                                },
                              }),
                            );
                          }}
                          title="Open in workspace"
                        >
                          →
                        </button>
                      </div>
                      {isExpanded && (
                        <div
                          className="text-[11px] text-[#888] leading-relaxed whitespace-pre-wrap"
                          style={{
                            maxHeight: 100,
                            overflowY: "auto",
                            padding: "6px 8px",
                            background: "rgba(255,255,255,0.04)",
                            borderRadius: 4,
                            margin: "4px 0 4px 20px",
                          }}
                        >
                          {source.text}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <div className="flex-1 overflow-hidden">
              <AIPanel
                vaultPath={vaultPath}
                onSourcesUpdate={(results) => {
                  setAiSources(results);
                  setExpandedIds(new Set());
                  if (results.length === 0) setSourcesOpen(false);
                }}
              />
            </div>
          </div>
        </section>
      </div>

      {/* Search panel modal — vaultPath may be null before vault opened */}
      <SearchPanel vaultPath={vaultPath} />
    </div>
  );
};
