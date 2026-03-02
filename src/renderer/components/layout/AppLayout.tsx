import React, { useState } from 'react';

import { AIPanel } from '../ai/AIPanel';
import { VaultSidebar } from '../vault/VaultSidebar';
import { Workspace } from '../workspace/Workspace';
import { WindowControlsToolbar } from './WindowControlsToolbar';

export const AppLayout: React.FC = () => {
  const [vaultCollapsed, setVaultCollapsed] = useState<boolean>(false);
  const [aiCollapsed, setAiCollapsed] = useState<boolean>(false);

  return (
    <div className="h-screen w-screen overflow-hidden flex flex-col bg-[#141414] text-[#d4d4d4]">

      {/* ── Global title bar ── spans full width, independent of all panels */}
      <header
        style={{
          background: '#1a1a1a',
          borderBottom: '1px solid #2a2a2a',
          WebkitAppRegion: 'drag',
        } as React.CSSProperties}
        className="h-10 shrink-0 w-full flex items-center justify-end"
      >
        <WindowControlsToolbar />
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
          {vaultCollapsed ? (
            <div className="h-full w-full flex flex-col">
              <div className="h-10 border-b border-[#2a2a2a] flex items-center justify-center">
                <button
                  type="button"
                  onClick={() => setVaultCollapsed(false)}
                  className="h-8 w-8 rounded-md text-[#d4d4d4] hover:bg-[#2a2a2a]"
                  aria-label="Expand vault sidebar"
                >
                  ⊞
                </button>
              </div>
            </div>
          ) : (
            <div className="h-full w-full flex flex-col overflow-hidden">
              <div className="h-10 border-b border-[#2a2a2a] flex items-center justify-between px-2">
                <span className="text-xs text-[#8a8a8a]">Vault</span>
                <button
                  type="button"
                  onClick={() => setVaultCollapsed(true)}
                  className="h-8 w-8 rounded-md text-[#d4d4d4] hover:bg-[#2a2a2a]"
                  aria-label="Collapse vault sidebar"
                >
                  ←
                </button>
              </div>
              <div className="flex-1 overflow-hidden">
                <VaultSidebar />
              </div>
            </div>
          )}
        </section>

        {/* Workspace */}
        <main
          style={{
            background: '#141414',
            borderRight: '1px solid #2a2a2a',
          }}
          className="h-full overflow-hidden flex-1 min-w-0"
        >
          <Workspace />
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
    </div>
  );
};