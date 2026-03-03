import React, { useState, useCallback, useEffect, useRef } from 'react';

import { Settings, Search } from 'lucide-react';
import { AIPanel } from '../ai/AIPanel';
import { SpotlightSearch } from '../search/SpotlightSearch';
import { VaultSidebar } from '../vault/VaultSidebar';
import { Workspace } from '../workspace/Workspace';
import { WindowControlsToolbar } from './WindowControlsToolbar';

export const AppLayout: React.FC = () => {
  const [vaultCollapsed, setVaultCollapsed] = useState<boolean>(false);
  const [aiCollapsed, setAiCollapsed]       = useState<boolean>(false);
  const [vaultPath, setVaultPath]           = useState<string | null>(null);

  const searchInputRef = useRef<HTMLInputElement>(null);

  const handleOpenNewVault = useCallback(() => {
    window.dispatchEvent(new CustomEvent('triggerOpenVault'));
  }, []);

  /* ── Ctrl+K → focus search ── */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchInputRef.current?.focus();
        window.dispatchEvent(new CustomEvent('spotlight:open'));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const noDragStyle = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;

  return (
    <div className="h-screen w-screen overflow-hidden flex flex-col bg-[#141414] text-[#d4d4d4]">

      {/* ── Global title bar ── search, Axiom, settings, window controls */}
      <header
        style={{
          background: '#1a1a1a',
          borderBottom: '1px solid #2a2a2a',
          WebkitAppRegion: 'drag',
        } as React.CSSProperties}
        className="h-10 shrink-0 w-full flex items-center px-4"
      >
        {/* Left: Axiom branding */}
        <div className="text-xs text-[#8a8a8a] shrink-0 mr-4 select-none">Axiom</div>

        {/* Center: Search bar */}
        <div className="flex-1 flex justify-center" style={noDragStyle}>
          <div className="relative w-full max-w-[400px]">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#5a5a5a] pointer-events-none" />
            <input
              ref={searchInputRef}
              placeholder="Search your vault... (Ctrl+K)"
              onClick={() => window.dispatchEvent(new CustomEvent('spotlight:open'))}
              readOnly
              className="w-full rounded-md bg-[#141414] border border-[#2a2a2a] pl-8 pr-3 py-1.5 text-sm text-[#d4d4d4] outline-none focus:border-[#3a3a3a] cursor-pointer"
            />
          </div>
        </div>

        {/* Right: Settings + window controls */}
        <div className="flex items-center shrink-0 ml-4" style={noDragStyle}>
          <button
            type="button"
            aria-label="Settings"
            className="h-8 w-8 rounded-md text-[#9a9a9a] hover:bg-[#2a2a2a] hover:text-[#d4d4d4] flex items-center justify-center"
          >
            <Settings size={16} />
          </button>
          <WindowControlsToolbar />
        </div>
      </header>

      {/* ── Three-panel row ── fills remaining height */}
      <div className="flex flex-1 min-h-0 overflow-hidden">

        {/* Vault sidebar */}
        <section
          style={{
            width: vaultCollapsed ? '36px' : '240px',
            transition: 'width 200ms ease-in-out',
            background: '#1e1e1e',
            borderRight: '1px solid #2a2a2a',
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
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
            style={{ display: vaultCollapsed ? 'none' : 'block' }}
          >
            <VaultSidebar onVaultOpen={setVaultPath} />
          </div>
        </section>

        {/* Workspace */}
        <main
          style={{
            background: '#141414',
            borderRight: '1px solid #2a2a2a',
          }}
          className="h-full overflow-hidden flex-1 min-w-0"
        >
          <Workspace vaultPath={vaultPath} />
        </main>

        {/* AI panel */}
        <section
          style={{
            width: aiCollapsed ? '36px' : '340px',
            transition: 'width 200ms ease-in-out',
            background: '#1e1e1e',
          }}
          className="h-full overflow-hidden shrink-0 flex flex-col"
        >
          {aiCollapsed ? (
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
          ) : (
            <div className="h-full w-full flex flex-col overflow-hidden">
              <div className="h-10 border-b border-[#2a2a2a] flex items-center justify-between px-2">
                <span className="text-xs text-[#8a8a8a]">AI</span>
                <button
                  type="button"
                  onClick={() => setAiCollapsed(true)}
                  className="h-8 w-8 rounded-md text-[#d4d4d4] hover:bg-[#2a2a2a]"
                  aria-label="Collapse AI panel"
                >
                  →
                </button>
              </div>
              <div className="flex-1 overflow-hidden">
                <AIPanel />
              </div>
            </div>
          )}
        </section>

      </div>

      {/* Spotlight search modal — vaultPath may be null before vault opened */}
      <SpotlightSearch vaultPath={vaultPath} />
    </div>
  );
};