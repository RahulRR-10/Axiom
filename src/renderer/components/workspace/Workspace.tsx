import React, { useEffect, useState } from 'react';

import { TopBar } from '../layout/TopBar';
import { WorkspaceTabBar, type WorkspaceMode } from './WorkspaceTabBar';
import { PDFViewer } from './pdf/PDFViewer';

type OpenFile = {
  filePath: string;
  fileId:   string | null;
  fileType: string;
};

type WorkspaceProps = {
  vaultPath?: string | null;
};

export const Workspace: React.FC<WorkspaceProps> = ({ vaultPath }) => {
  const [mode,      setMode]      = useState<WorkspaceMode>('pdf');
  const [openFile,  setOpenFile]  = useState<OpenFile | null>(null);

  // ── Listen for openFile events from VaultSidebar ─────────────────────────
  useEffect(() => {
    const handler = async (e: Event) => {
      const { filePath, fileType } = (e as CustomEvent<{ filePath: string; fileType: string }>).detail;

      // Resolve SQLite fileId if vault is open
      let fileId: string | null = null;
      if (vaultPath) {
        try {
          fileId = await window.electronAPI.getFileId(vaultPath, filePath);
        } catch { /* ignore — annotations won't persist until file is indexed */ }
      }

      setOpenFile({ filePath, fileId, fileType });

      // Auto-switch to the right tab
      if (fileType === 'pdf') setMode('pdf');
      else setMode('notes');
    };

    window.addEventListener('openFile', handler as EventListener);
    return () => window.removeEventListener('openFile', handler as EventListener);
  }, [vaultPath]);

  // ── Render content based on active mode ──────────────────────────────────
  const renderContent = () => {
    if (mode === 'pdf') {
      if (!openFile || openFile.fileType !== 'pdf') {
        return (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-[#4e4e4e] text-sm select-none">
              Open a PDF from the vault to view it here
            </p>
          </div>
        );
      }
      return (
        <div className="flex-1 min-h-0 overflow-hidden">
          <PDFViewer
            filePath={openFile.filePath}
            fileId={openFile.fileId ?? ''}
            vaultPath={vaultPath}
          />
        </div>
      );
    }

    if (mode === 'notes') {
      return (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-[#4e4e4e] text-sm select-none">
            Notes editor — Phase 4
          </p>
        </div>
      );
    }

    // search mode
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-[#4e4e4e] text-sm select-none">
          Search results — Phase 5
        </p>
      </div>
    );
  };

  return (
    <section className="h-full w-full flex flex-col overflow-hidden">
      <TopBar />
      <WorkspaceTabBar activeMode={mode} onModeChange={setMode} />
      {renderContent()}
    </section>
  );
};
