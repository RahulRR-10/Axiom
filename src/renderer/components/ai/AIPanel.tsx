import React, { useCallback, useEffect, useRef, useState } from "react";

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

// ── Tab instance ─────────────────────────────────────────────────────────────

type TabInstance = {
  instanceId: string;
  serviceId: string;
};

let _tabCounter = 0;
const nextInstanceId = (serviceId: string): string => `${serviceId}-${_tabCounter++}`;

// ── Props ────────────────────────────────────────────────────────────────────

type AIPanelProps = {
  vaultPath: string | null;
  onSourcesUpdate: (sources: SearchResult[]) => void;
};

// ── Component ────────────────────────────────────────────────────────────────

export const AIPanel: React.FC<AIPanelProps> = ({ vaultPath, onSourcesUpdate }) => {
  const [tabs, setTabs] = useState<TabInstance[]>(() =>
    AI_SERVICES.map((s) => ({ instanceId: nextInstanceId(s.id), serviceId: s.id })),
  );
  const [activeTabId, setActiveTabId] = useState<string>(
    () => tabs[0].instanceId,
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const [preloadURL, setPreloadURL] = useState<string | null>(null);
  const webviewRefs = useRef<Record<string, Electron.WebviewTag | null>>({});

  const [loading, setLoading] = useState(false);
  const [, setError] = useState<string | null>(null);

  // ── Close picker on outside click ─────────────────────────────────────────

  useEffect(() => {
    if (!pickerOpen) return;
    const handler = (e: MouseEvent): void => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [pickerOpen]);

  // ── Tab management ────────────────────────────────────────────────────────

  const addTab = useCallback((serviceId: string): void => {
    const instanceId = nextInstanceId(serviceId);
    setTabs((prev) => [...prev, { instanceId, serviceId }]);
    setActiveTabId(instanceId);
    setPickerOpen(false);
  }, []);

  const closeTab = useCallback((instanceId: string): void => {
    setTabs((prev) => {
      if (prev.length === 1) return prev;
      const next = prev.filter((t) => t.instanceId !== instanceId);
      setActiveTabId((cur) => {
        if (cur !== instanceId) return cur;
        const idx = prev.findIndex((t) => t.instanceId === instanceId);
        return next[Math.max(0, idx - 1)].instanceId;
      });
      return next;
    });
  }, []);

  // Fetch the preload path once on mount
  useEffect(() => {
    window.electronAPI.getAIPreloadPath().then(setPreloadURL);
  }, []);

  // Register webviews once preload is ready or tabs change
  useEffect(() => {
    if (!preloadURL) return;

    const cleanups: (() => void)[] = [];

    for (const tab of tabs) {
      const el = webviewRefs.current[tab.instanceId];
      if (!el) continue;

      const onReady = (): void => {
        try {
          window.electronAPI.registerWebview(
            tab.instanceId,
            (el as unknown as { getWebContentsId: () => number }).getWebContentsId(),
          );
        } catch {
          // webview may not be fully ready
        }
      };

      el.addEventListener("dom-ready", onReady);
      cleanups.push(() => el.removeEventListener("dom-ready", onReady));
    }

    return () => cleanups.forEach((fn) => fn());
  }, [preloadURL, tabs]);

  // ── Listen for sendToAI event from FloatingActionBar ─────────────────────

  useEffect(() => {
    const handler = async (e: Event): Promise<void> => {
      const { text, customPrompt } = (e as CustomEvent<{ text: string; customPrompt?: string }>).detail;
      if (!text.trim() || loading) return;

      setError(null);

      try {
        const instruction = customPrompt?.trim()
          ? customPrompt.trim()
          : 'Explain the following text clearly and concisely.';

        const prompt = [
          instruction,
          '',
          'TEXT',
          '----',
          text,
        ].join('\n');

        const { success, error: injErr } = await window.electronAPI.vaultInject(
          activeTabId,
          tabs.find((t) => t.instanceId === activeTabId)?.serviceId ?? activeTabId,
          prompt,
        );

        if (!success) {
          setError(injErr ?? "Failed to send to AI");
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Something went wrong";
        setError(message);
      }
    };

    window.addEventListener("sendToAI", handler);
    return () => window.removeEventListener("sendToAI", handler);
  }, [activeTabId, loading]);

  // ── Listen for ai:ask event from AppLayout ─────────────────────────────────

  useEffect(() => {
    const handler = async (e: Event): Promise<void> => {
      const question = (e as CustomEvent<{ question: string }>).detail.question;
      if (!question.trim() || loading || !vaultPath) return;

      setLoading(true);
      setError(null);
      onSourcesUpdate([]);

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
          activeTabId,
          tabs.find((t) => t.instanceId === activeTabId)?.serviceId ?? activeTabId,
          prompt,
        );

        if (!success) {
          setError(injErr ?? "Failed to send to AI");
          return;
        }

        // 4. Notify parent with sources
        onSourcesUpdate(results);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Something went wrong";
        setError(message);
      } finally {
        setLoading(false);
      }
    };

    window.addEventListener("ai:ask", handler);
    return () => window.removeEventListener("ai:ask", handler);
  }, [activeTabId, loading, vaultPath, onSourcesUpdate]);

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
      {/* ── Tab row ── */}
      <div className="flex shrink-0 border-b border-[#2a2a2a] bg-[#1a1a1a]">
        {/* Scrollable tab strip */}
        <div
          className="flex flex-1 overflow-x-auto min-w-0"
          style={{ scrollbarWidth: "none" }}
        >
          {tabs.map((tab) => {
            const svc = AI_SERVICES.find((s) => s.id === tab.serviceId)!;
            const svcInstances = tabs.filter((t) => t.serviceId === tab.serviceId);
            const svcIdx = svcInstances.findIndex((t) => t.instanceId === tab.instanceId);
            const label = svcInstances.length > 1 ? `${svc.label} ${svcIdx + 1}` : svc.label;
            const isActive = activeTabId === tab.instanceId;
            return (
              <div
                key={tab.instanceId}
                className={`
                  group shrink-0 flex items-stretch whitespace-nowrap
                  ${isActive ? "border-b-2 border-[#4a9eff] bg-[#1e1e1e]" : "border-b-2 border-transparent hover:bg-[#222]"}
                `}
              >
                <button
                  type="button"
                  onClick={() => setActiveTabId(tab.instanceId)}
                  className={`flex items-center gap-1.5 pl-2.5 pr-1 py-1.5 text-xs font-medium transition-colors ${isActive ? "text-[#e0e0e0]" : "text-[#6a6a6a] group-hover:text-[#9a9a9a]"}`}
                >
                  <span>{svc.icon}</span>
                  <span>{label}</span>
                </button>
                <button
                  type="button"
                  onClick={() => closeTab(tab.instanceId)}
                  aria-label={`Close ${label}`}
                  className={`flex items-center pr-2 pl-0.5 py-1.5 text-xs transition-colors opacity-0 group-hover:opacity-100 ${isActive ? "text-[#6a6a6a] hover:text-[#e0e0e0]" : "text-[#5a5a5a] hover:text-[#aaa]"}`}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>

        {/* + button — outside scroll container so dropdown isn't clipped */}
        <div ref={pickerRef} className="relative shrink-0 flex items-stretch border-l border-[#2a2a2a]">
          <button
            type="button"
            onClick={() => setPickerOpen((v) => !v)}
            className="px-2.5 text-[#5a5a5a] hover:text-[#aaa] hover:bg-[#222] text-sm transition-colors"
            title="Add tab"
          >
            +
          </button>
          {pickerOpen && (
            <div className="absolute top-full right-0 mt-0.5 z-50 bg-[#252525] border border-[#333] rounded shadow-lg py-1 min-w-[130px]">
              {AI_SERVICES.map((svc) => (
                <button
                  key={svc.id}
                  type="button"
                  onClick={() => addTab(svc.id)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[#ccc] hover:bg-[#333] transition-colors"
                >
                  <span>{svc.icon}</span>
                  <span>{svc.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Loading indicator ── */}
      {loading && (
        <div className="shrink-0 px-2.5 py-1.5 bg-[#1a1a1a] border-b border-[#2a2a2a] flex items-center gap-2">
          <div className="w-3 h-3 border-2 border-[#3a3a3a] border-t-[#4a9eff] rounded-full animate-spin" />
          <span className="text-[10px] text-[#6a6a6a]">Searching vault…</span>
        </div>
      )}

      {/* ── Webview container ── */}
      <div className="flex-1 relative min-h-0">
        {tabs.map((tab) => {
          const svc = AI_SERVICES.find((s) => s.id === tab.serviceId)!;
          return (
            <webview
              key={tab.instanceId}
              ref={(el) => {
                webviewRefs.current[tab.instanceId] = el as unknown as Electron.WebviewTag | null;
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
                display: activeTabId === tab.instanceId ? "flex" : "none",
              }}
            />
          );
        })}
      </div>
    </div>
  );
};
