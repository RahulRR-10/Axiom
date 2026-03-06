import React, { useEffect, useRef, useState } from 'react';
import { ZoomIn, ZoomOut } from 'lucide-react';

import { AppLayout } from './components/layout/AppLayout';
import { PDFViewer } from './components/workspace/pdf/PDFViewer';
import { NotesEditor } from './components/workspace/notes/NotesEditor';
import { WindowControlsToolbar } from './components/layout/WindowControlsToolbar';

/**
 * Detect single-file mode via ?singleFile= query param (used by "Open in new window").
 */
const params = new URLSearchParams(window.location.search);
const singleFilePath = params.get('singleFile');
const singleFileType = params.get('fileType') ?? 'pdf';
const singleVaultPath = params.get('vaultPath');

const IMAGE_TYPES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp']);

function normalizePath(p: string | null | undefined): string {
  return (p ?? '').replace(/\\/g, '/').toLowerCase();
}

// ── Standalone image viewer with zoom ─────────────────────────────────────────

const StandaloneImageViewer: React.FC<{ filePath: string }> = ({ filePath }) => {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileName = filePath.split(/[\\/]/).pop() ?? 'image';

  useEffect(() => {
    window.electronAPI.readFile(filePath)
      .then((bytes) => {
        const ext = filePath.split('.').pop()?.toLowerCase() || 'png';
        const mimeMap: Record<string, string> = {
          png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
          gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
        };
        const mime = mimeMap[ext] || 'image/png';
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        setSrc(`data:${mime};base64,${btoa(binary)}`);
      })
      .catch(() => setError(true));
  }, [filePath]);

  // Touchpad pinch-to-zoom — exact same mechanism as PDFViewer
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const delta = -e.deltaY * 0.01;
      setZoom(prev => Math.min(4, Math.max(0.25, prev + delta)));
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [src]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%' }}>
      {/* Image toolbar with zoom controls */}
      <div className="flex items-center h-10 px-3 bg-[#1e1e1e] border-b border-[#2a2a2a] gap-1 shrink-0">
        <span className="text-xs text-[#8a8a8a] select-none mr-auto truncate">{fileName}</span>
        <button
          type="button"
          onClick={() => setZoom(prev => Math.max(0.25, prev - 0.25))}
          className="h-8 w-8 flex items-center justify-center rounded text-[#8a8a8a] hover:bg-[#2a2a2a] hover:text-[#d4d4d4] transition-colors"
          title="Zoom Out"
        >
          <ZoomOut size={16} />
        </button>
        <span className="text-xs text-[#d4d4d4] w-12 text-center select-none">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          onClick={() => setZoom(prev => Math.min(4, prev + 0.25))}
          className="h-8 w-8 flex items-center justify-center rounded text-[#8a8a8a] hover:bg-[#2a2a2a] hover:text-[#d4d4d4] transition-colors"
          title="Zoom In"
        >
          <ZoomIn size={16} />
        </button>
      </div>
      {/* Scroll container */}
      <div
        ref={scrollRef}
        style={{ flex: 1, overflow: 'auto', background: '#141414' }}
      >
        {error && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
            <p className="text-[#666] text-sm">Failed to load image</p>
          </div>
        )}
        {!src && !error && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
            <p className="text-[#4e4e4e] text-sm">Loading…</p>
          </div>
        )}
        {src && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100%', minWidth: '100%', padding: 24 }}>
            <img
              src={src}
            alt={fileName}
            draggable={false}
            className="select-none"
            onLoad={(e) => {
              const img = e.currentTarget;
              setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
            }}
            style={naturalSize
              ? { width: naturalSize.w * zoom, height: naturalSize.h * zoom }
              : { maxWidth: '100%', maxHeight: '100%' }
            }
          />
          </div>
        )}
      </div>
    </div>
  );
};

// ── SingleFileWindow ──────────────────────────────────────────────────────────

const SingleFileWindow: React.FC<{ filePath: string; fileType: string; vaultPath: string | null }> = ({ filePath, fileType, vaultPath }) => {
  const name = filePath.split(/[\\/]/).pop() ?? filePath;
  const [fileId, setFileId] = useState<string | null>(null);
  const [pdfNonce, setPdfNonce] = useState(0);

  // Resolve fileId from DB so annotations/notes load correctly
  useEffect(() => {
    if (!vaultPath) return;
    window.electronAPI.getFileId(vaultPath, filePath)
      .then((id) => setFileId(id))
      .catch(console.error);
  }, [vaultPath, filePath]);

  // Cross-window sync: close this child window when the same md file is saved elsewhere
  useEffect(() => {
    if (fileType !== 'md') return;
    const unsub = window.electronAPI.onNoteSaved((savedPath) => {
      if (normalizePath(savedPath) === normalizePath(filePath)) {
        window.electronAPI.closeWindow();
      }
    });
    return unsub;
  }, [filePath, fileType]);

  // Cross-window sync: force-reload PDF when saved elsewhere
  useEffect(() => {
    if (fileType !== 'pdf') return;
    const unsub1 = window.electronAPI.onPdfFileChanged((changedPath) => {
      if (normalizePath(changedPath) === normalizePath(filePath)) setPdfNonce(Date.now());
    });
    const unsub2 = window.electronAPI.onAnnotationsSaved((savedPath) => {
      if (normalizePath(savedPath) === normalizePath(filePath)) setPdfNonce(Date.now());
    });
    return () => { unsub1(); unsub2(); };
  }, [filePath, fileType]);

  const renderContent = () => {
    if (fileType === 'pdf') {
      return (
        <PDFViewer
          key={pdfNonce}
          filePath={filePath}
          fileId={fileId ?? ''}
          vaultPath={vaultPath}
        />
      );
    }

    if (IMAGE_TYPES.has(fileType)) {
      return <StandaloneImageViewer filePath={filePath} />;
    }

    if (fileType === 'md') {
      return (
        <NotesEditor
          filePath={filePath}
          noteId={fileId ?? ''}
          vaultPath={vaultPath ?? ''}
        />
      );
    }

    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-[#4e4e4e] text-sm">Unsupported file type</p>
      </div>
    );
  };

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
        {renderContent()}
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