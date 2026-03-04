import React, { useEffect, useState, useCallback } from 'react';
import { X } from 'lucide-react';

import { PDFViewer } from './pdf/PDFViewer';
import { NotesEditor } from './notes/NotesEditor';

type OpenFile = {
  filePath: string;
  fileId: string | null;
  fileType: string;
  name: string;
  initialPage?: number;
  scrollNonce?: number;  // increment to force re-scroll to same page
};

type WorkspaceProps = {
  vaultPath?: string | null;
};

export const Workspace: React.FC<WorkspaceProps> = ({ vaultPath }) => {
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activeIdx, setActiveIdx] = useState(-1);

  const activeFile = activeIdx >= 0 ? openFiles[activeIdx] ?? null : null;

  // ── Listen for openFile events from VaultSidebar ─────────────────────────
  useEffect(() => {
    const handler = async (e: Event) => {
      const { filePath, fileType, page } = (e as CustomEvent<{ filePath: string; fileType: string; page?: number }>).detail;

      // Check if already open — switch to it and navigate to the page
      const existingIdx = openFiles.findIndex(f => f.filePath === filePath);
      if (existingIdx >= 0) {
        setActiveIdx(existingIdx);
        if (page) {
          // Update initialPage + nonce so PDFViewer re-scrolls (even to same page)
          setOpenFiles(prev => prev.map((f, i) =>
            i === existingIdx ? { ...f, initialPage: page, scrollNonce: Date.now() } : f,
          ));
        }
        return;
      }

      // Resolve SQLite fileId if vault is open
      let fileId: string | null = null;
      if (vaultPath) {
        try {
          fileId = await window.electronAPI.getFileId(vaultPath, filePath);
        } catch { /* ignore */ }
      }

      const name = filePath.split(/[\\/]/).pop() ?? filePath;
      const newFile: OpenFile = { filePath, fileId, fileType, name, initialPage: page };

      setOpenFiles(prev => [...prev, newFile]);
      setActiveIdx(openFiles.length); // will be the new last index
    };

    window.addEventListener('openFile', handler as EventListener);
    return () => window.removeEventListener('openFile', handler as EventListener);
  }, [vaultPath, openFiles]);

  // ── Close a tab ──────────────────────────────────────────────────────────
  const closeTab = useCallback((idx: number, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setOpenFiles(prev => {
      const next = [...prev];
      next.splice(idx, 1);
      return next;
    });
    setActiveIdx(prev => {
      if (idx < prev) return prev - 1;
      if (idx === prev) return Math.min(prev, openFiles.length - 2);
      return prev;
    });
  }, [openFiles.length]);

  // ── Render content based on active file ──────────────────────────────────
  const renderContent = () => {
    if (!activeFile) {
      return (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-[#4e4e4e] text-sm select-none">
            Open a file from the vault to get started
          </p>
        </div>
      );
    }

    if (activeFile.fileType === 'pdf') {
      return (
        <div className="flex-1 min-h-0 overflow-hidden">
          <PDFViewer
            key={activeFile.filePath}
            filePath={activeFile.filePath}
            fileId={activeFile.fileId ?? ''}
            vaultPath={vaultPath}
            initialPage={activeFile.initialPage}
            scrollNonce={activeFile.scrollNonce}
          />
        </div>
      );
    }

    if (activeFile.fileType === 'md') {
      return (
        <div className="flex-1 min-h-0 overflow-hidden">
          <NotesEditor
            key={activeFile.filePath}
            filePath={activeFile.filePath}
            noteId={activeFile.fileId ?? ''}
            vaultPath={vaultPath ?? ''}
          />
        </div>
      );
    }

    // Non-PDF / non-MD files — placeholder
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-[#4e4e4e] text-sm select-none">
          {activeFile.name} — unsupported file type
        </p>
      </div>
    );
  };

  // ── Tab color based on file type ────────────────────────────────────────
  const tabColor = (ft: string) => {
    if (ft === 'pdf') return 'bg-red-500';
    if (ft === 'md') return 'bg-blue-400';
    return 'bg-gray-400';
  };

  return (
    <section className="h-full w-full flex flex-col overflow-hidden">

      {/* ── Tab bar ── */}
      {openFiles.length > 0 && (
        <div
          style={{
            height: '36px',
            background: '#181818',
            borderBottom: '1px solid #2a2a2a',
            flexShrink: 0,
          }}
          className="flex items-stretch overflow-x-auto"
        >
          {openFiles.map((f, i) => (
            <button
              key={f.filePath}
              type="button"
              onClick={() => setActiveIdx(i)}
              className={`group flex items-center gap-1.5 px-3 text-xs border-r border-[#2a2a2a] whitespace-nowrap transition-colors ${i === activeIdx
                  ? 'bg-[#1e1e1e] text-[#e4e4e4]'
                  : 'text-[#6e6e6e] hover:bg-[#222] hover:text-[#aaa]'
                }`}
              style={{ maxWidth: '200px' }}
            >
              {/* File type indicator */}
              <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${tabColor(f.fileType)}`} />

              {/* File name — truncated */}
              <span className="truncate">{f.name}</span>

              {/* Close button */}
              <span
                onClick={(e) => closeTab(i, e)}
                className="ml-auto flex-shrink-0 rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-[#3a3a3a] transition-opacity"
                title="Close tab"
              >
                <X size={12} />
              </span>
            </button>
          ))}
        </div>
      )}

      {renderContent()}
    </section>
  );
};
