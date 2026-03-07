import React, { useEffect, useRef, useState } from "react";

import type { SearchResult } from "../../../shared/types";
import { buildVaultPrompt } from "../../utils/buildVaultPrompt";

// ── AI service definitions ───────────────────────────────────────────────────

type AIService = {
  id: string;
  label: string;
  url: string;
  partition: string;
  icon: string;
};

const AI_SERVICES: AIService[] = [
  {
    id: "chatgpt",
    label: "ChatGPT",
    url: "https://chatgpt.com",
    partition: "persist:chatgpt",
    icon: "⬡",
  },
  {
    id: "gemini",
    label: "Gemini",
    url: "https://gemini.google.com",
    partition: "persist:gemini",
    icon: "◈",
  },
  {
    id: "claude",
    label: "Claude",
    url: "https://claude.ai",
    partition: "persist:claude",
    icon: "◉",
  },
];

// ── Props ────────────────────────────────────────────────────────────────────

type AIPanelProps = {
  vaultPath: string | null;
};

// ── Component ────────────────────────────────────────────────────────────────

export const AIPanel: React.FC<AIPanelProps> = ({ vaultPath }) => {
  const [activeTab, setActiveTab] = useState<string>("chatgpt");
  const [preloadURL, setPreloadURL] = useState<string | null>(null);
  const webviewRefs = useRef<Record<string, Electron.WebviewTag | null>>({});

  // Sources state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sources, setSources] = useState<SearchResult[]>([]);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  // Fetch the preload path once on mount
  useEffect(() => {
    window.electronAPI.getAIPreloadPath().then(setPreloadURL);
  }, []);

  // Register webviews once preload is ready
  useEffect(() => {
    if (!preloadURL) return;

    const cleanups: (() => void)[] = [];

    for (const svc of AI_SERVICES) {
      const el = webviewRefs.current[svc.id];
      if (!el) continue;

      const onReady = (): void => {
        try {
          window.electronAPI.registerWebview(svc.id, (el as unknown as { getWebContentsId: () => number }).getWebContentsId());
        } catch {
          // webview may not be fully ready
        }
      };

      el.addEventListener("dom-ready", onReady);
      cleanups.push(() => el.removeEventListener("dom-ready", onReady));
    }

    return () => cleanups.forEach((fn) => fn());
  }, [preloadURL]);

  // ── Listen for sendToAI event from FloatingActionBar ─────────────────────

  useEffect(() => {
    const handler = async (e: Event): Promise<void> => {
      const { text } = (e as CustomEvent<{ text: string }>).detail;
      if (!text.trim() || loading) return;

      setLoading(true);
      setError(null);

      try {
        const prompt = [
          'Explain the following text clearly and concisely.',
          '',
          'TEXT',
          '----',
          text,
        ].join('\n');

        const { success, error: injErr } = await window.electronAPI.vaultInject(
          activeTab,
          prompt,
        );

        if (!success) {
          setError(injErr ?? "Failed to send to AI");
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Something went wrong";
        setError(message);
      } finally {
        setLoading(false);
      }
    };

    window.addEventListener("sendToAI", handler);
    return () => window.removeEventListener("sendToAI", handler);
  }, [activeTab, loading]);

  // ── Listen for ai:ask event from AppLayout ─────────────────────────────────

  useEffect(() => {
    const handler = async (e: Event): Promise<void> => {
      const question = (e as CustomEvent<{ question: string }>).detail.question;
      if (!question.trim() || loading || !vaultPath) return;

      setLoading(true);
      setError(null);
      setSources([]);
      setExpandedIds(new Set());
      setSourcesOpen(false);

      try {
        // 1. Retrieve chunks — take only top 2
        const allResults: SearchResult[] = await window.electronAPI.search(
          question,
          vaultPath,
        );
        const results = allResults.slice(0, 2);

        // 2. Build grounded prompt
        const prompt = buildVaultPrompt(question, results);

        // 3. Inject into active webview
        const { success, error: injErr } = await window.electronAPI.vaultInject(
          activeTab,
          prompt,
        );

        if (!success) {
          setError(injErr ?? "Failed to send to AI");
          return;
        }

        // 4. Show sources (closed by default — user can open)
        setSources(results);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Something went wrong";
        setError(message);
      } finally {
        setLoading(false);
      }
    };

    window.addEventListener("ai:ask", handler);
    return () => window.removeEventListener("ai:ask", handler);
  }, [activeTab, loading, vaultPath]);

  // NOTE: Popup handling (Google auth, etc.) is managed from the main process
  // via setWindowOpenHandler in spoofing.ts — do NOT intercept new-window here
  // or auth flows will break.

  if (!preloadURL) {
    return (
      <div className="h-full w-full flex items-center justify-center text-xs text-[#5a5a5a]">
        Loading AI panel…
      </div>
    );
  }

  return (
    <div className="h-full w-full flex flex-col">
      {/* ── Tab row + Sources dropdown ── */}
      <div className="flex shrink-0 border-b border-[#2a2a2a] bg-[#1a1a1a]">
        {AI_SERVICES.map((svc) => (
          <button
            key={svc.id}
            type="button"
            onClick={() => setActiveTab(svc.id)}
            className={`
              flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5
              text-xs font-medium transition-colors
              ${
                activeTab === svc.id
                  ? "text-[#e0e0e0] border-b-2 border-[#4a9eff] bg-[#1e1e1e]"
                  : "text-[#6a6a6a] hover:text-[#9a9a9a] hover:bg-[#222]"
              }
            `}
          >
            <span>{svc.icon}</span>
            <span>{svc.label}</span>
          </button>
        ))}

        {/* Sources dropdown toggle */}
        <button
          type="button"
          onClick={() => sources.length > 0 && setSourcesOpen((v) => !v)}
          disabled={sources.length === 0}
          className={`
            shrink-0 flex items-center gap-1 px-2.5 py-1.5
            text-[10px] font-medium transition-colors border-l border-[#2a2a2a]
            ${
              sources.length > 0
                ? "text-[#8a8a8a] hover:text-[#ccc] hover:bg-[#252525] cursor-pointer"
                : "text-[#3a3a3a] cursor-default"
            }
          `}
          title={sources.length > 0 ? "Toggle sources" : "No sources yet"}
        >
          <span>{sourcesOpen ? "▼" : "▶"}</span>
          <span>Sources{sources.length > 0 ? ` (${sources.length})` : ""}</span>
        </button>
      </div>

      {/* ── Error message ── */}
      {error && (
        <div className="shrink-0 px-2.5 py-1 bg-[#1a1a1a] border-b border-[#2a2a2a]">
          <p className="text-[10px] text-red-400">{error}</p>
        </div>
      )}

      {/* ── Loading indicator ── */}
      {loading && (
        <div className="shrink-0 px-2.5 py-1.5 bg-[#1a1a1a] border-b border-[#2a2a2a] flex items-center gap-2">
          <div className="w-3 h-3 border-2 border-[#3a3a3a] border-t-[#4a9eff] rounded-full animate-spin" />
          <span className="text-[10px] text-[#6a6a6a]">Searching vault…</span>
        </div>
      )}

      {/* ── Sources panel (collapsible) ── */}
      {sourcesOpen && sources.length > 0 && (
        <div
          className="shrink-0 border-b border-[#2a2a2a] bg-[#1a1a1a]"
          style={{ maxHeight: 180, overflowY: "auto" }}
        >
          {sources.map((source) => {
            const isExpanded = expandedIds.has(source.id);
            return (
              <div key={source.id} className="px-2 py-1">
                <div className="flex items-center gap-1.5">
                  {/* Chevron toggle */}
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

                  {/* Source name */}
                  <span className="text-[11px] text-[#bbb] truncate flex-1">
                    {source.file_name}
                    {source.page_or_slide != null
                      ? ` — Page ${source.page_or_slide}`
                      : ""}
                  </span>

                  {/* Open in workspace */}
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

                {/* Expanded chunk text */}
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

      {/* ── Webview container ── */}
      <div className="flex-1 relative min-h-0">
        {AI_SERVICES.map((svc) => (
          <webview
            key={svc.id}
            ref={(el) => {
              webviewRefs.current[svc.id] = el as unknown as Electron.WebviewTag | null;
            }}
            src={svc.url}
            partition={svc.partition}
            preload={preloadURL}
            webpreferences="contextIsolation=no"
            allowpopups={"true" as unknown as boolean}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              display: activeTab === svc.id ? "flex" : "none",
            }}
          />
        ))}
      </div>
    </div>
  );
};
