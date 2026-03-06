import React, { useEffect, useState } from 'react';

import { AppLayout } from './components/layout/AppLayout';
import { PDFViewer } from './components/workspace/pdf/PDFViewer';
import { WindowControlsToolbar } from './components/layout/WindowControlsToolbar';

/**
 * Detect single-file mode via ?singleFile= query param (used by "Open in new window").
 */
const params = new URLSearchParams(window.location.search);
const singleFilePath = params.get('singleFile');
const singleFileType = params.get('fileType') ?? 'pdf';
const singleVaultPath = params.get('vaultPath');

const SingleFileWindow: React.FC<{ filePath: string; fileType: string; vaultPath: string | null }> = ({ filePath, fileType, vaultPath }) => {
  const name = filePath.split(/[\\/]/).pop() ?? filePath;
  const [fileId, setFileId] = useState<string | null>(null);

  // Resolve fileId from DB so annotations load correctly
  useEffect(() => {
    if (!vaultPath) return;
    window.electronAPI.getFileId(vaultPath, filePath)
      .then((id) => setFileId(id))
      .catch(console.error);
  }, [vaultPath, filePath]);

  return (
    <div className="h-screen w-screen flex flex-col bg-[#141414] text-[#d4d4d4]">
      {/* Minimal title bar */}
      <header
        style={{ background: '#1a1a1a', borderBottom: '1px solid #2a2a2a', WebkitAppRegion: 'drag' } as React.CSSProperties}
        className="h-10 shrink-0 w-full flex items-center px-4"
      >
        <span className="text-xs text-[#8a8a8a] truncate flex-1 select-none">{name}</span>
        <div style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <WindowControlsToolbar />
        </div>
      </header>
      <main className="flex-1 min-h-0 overflow-hidden">
        <PDFViewer
          filePath={filePath}
          fileId={fileId ?? ''}
          vaultPath={vaultPath}
        />
      </main>
    </div>
  );
};

export const App: React.FC = () => {
  if (singleFilePath) {
    return <SingleFileWindow filePath={singleFilePath} fileType={singleFileType} vaultPath={singleVaultPath} />;
  }
  return <AppLayout />;
};