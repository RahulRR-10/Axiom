import React, { useEffect, useRef, useState } from "react";

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

// ── Component ────────────────────────────────────────────────────────────────

export const AIPanel: React.FC = () => {
  const [activeTab, setActiveTab] = useState<string>("chatgpt");
  const [preloadURL, setPreloadURL] = useState<string | null>(null);
  const webviewRefs = useRef<Record<string, Electron.WebviewTag | null>>({});

  // Fetch the preload path once on mount
  useEffect(() => {
    window.electronAPI.getAIPreloadPath().then(setPreloadURL);
  }, []);

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
      </div>

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
            // contextIsolation must be OFF so preload patches (navigator.webdriver,
            // window.chrome, plugins, WebGL, etc.) run in the PAGE context, not
            // an isolated one.  Without this, Google sees the real Electron values.
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
