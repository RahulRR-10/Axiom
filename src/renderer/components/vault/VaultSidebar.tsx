import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  PlusCircle,
} from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';

import type { FileNode, IndexStatus } from '../../../shared/types';

// ── Types ─────────────────────────────────────────────────────────────────────

type VaultSidebarProps = {
  onVaultOpen?: (vaultPath: string) => void;
  onFileOpen?: (filePath: string, fileType: string) => void;
};

// ── Component ─────────────────────────────────────────────────────────────────

export const VaultSidebar: React.FC<VaultSidebarProps> = ({ onVaultOpen, onFileOpen }) => {
  const [vaultPath, setVaultPath]     = useState<string | null>(null);
  const [files, setFiles]             = useState<FileNode[]>([]);
  const [indexStatus, setIndexStatus] = useState<IndexStatus | null>(null);
  const [activeFile, setActiveFile]   = useState<string | null>(null);

  // Subscribe to background indexing progress and file-change events
  useEffect(() => {
    const unsubProgress = window.electronAPI.onIndexProgress((payload) => {
      setIndexStatus({ ...payload });
    });
    const unsubChanged = window.electronAPI.onFileChanged(({ vaultPath: vp }) => {
      if (vp === vaultPath) void refreshTree(vp);
    });
    return () => { unsubProgress(); unsubChanged(); };
  }, [vaultPath]);

  const handleOpenVault = useCallback(async () => {
    const selected = await window.electronAPI.selectVaultFolder();
    if (!selected) return;
    const { files: tree, status } = await window.electronAPI.openVault(selected);
    setVaultPath(selected);
    setFiles(tree);
    setIndexStatus(status);
    onVaultOpen?.(selected);
  }, [onVaultOpen]);

  // Allow external trigger (e.g. header "Open Vault" button) via custom event
  useEffect(() => {
    const handler = (): void => { void handleOpenVault(); };
    window.addEventListener('triggerOpenVault', handler);
    return () => window.removeEventListener('triggerOpenVault', handler);
  }, [handleOpenVault]);

  async function refreshTree(vp: string): Promise<void> {
    const tree = await window.electronAPI.readDirectory(vp);
    setFiles(tree);
  }

  const handleFileClick = useCallback((node: FileNode) => {
    setActiveFile(node.path);
    onFileOpen?.(node.path, node.fileType ?? 'txt');
    window.dispatchEvent(
      new CustomEvent('openFile', { detail: { filePath: node.path, fileType: node.fileType } }),
    );
  }, [onFileOpen]);

  const vaultName = vaultPath
    ? vaultPath.split(/[/\\]/).filter(Boolean).slice(-1)[0] ?? vaultPath
    : null;

  // ── Empty state ───────────────────────────────────────────────────────────
  if (!vaultPath) {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center gap-3 p-4">
        <p className="text-xs text-[#6a6a6a] text-center">No vault open</p>
        <button
          type="button"
          onClick={() => void handleOpenVault()}
          className="px-3 py-1.5 rounded-md bg-[#2a2a2a] hover:bg-[#3a3a3a] text-xs text-[#d4d4d4] transition-colors"
        >
          Open Vault…
        </button>
      </div>
    );
  }

  const indexPercent =
    indexStatus && indexStatus.total > 0
      ? Math.round((indexStatus.indexed / indexStatus.total) * 100)
      : null;

  return (
    <div className="h-full w-full flex flex-col overflow-hidden">

      {/* Vault name + new note button */}
      <div className="px-2 py-1.5 flex items-center justify-between border-b border-[#2a2a2a]">
        <span className="text-xs font-semibold text-[#d4d4d4] truncate" title={vaultPath}>
          {vaultName}
        </span>
        <button
          type="button"
          title="New Note"
          className="h-6 w-6 rounded text-[#8a8a8a] hover:text-[#d4d4d4] hover:bg-[#2a2a2a] flex items-center justify-center shrink-0"
          onClick={() => window.dispatchEvent(new CustomEvent('newNote'))}
        >
          <PlusCircle size={14} />
        </button>
      </div>

      {/* Indexing progress */}
      {indexStatus?.inProgress && (
        <div className="px-2 py-1 border-b border-[#2a2a2a]">
          <div className="flex justify-between text-[10px] text-[#6a6a6a] mb-1">
            <span>Indexing…</span>
            <span>{indexStatus.indexed}/{indexStatus.total}</span>
          </div>
          <div className="w-full h-1 bg-[#2a2a2a] rounded-full overflow-hidden">
            <div
              className="h-full bg-[#4a9eff] rounded-full transition-all duration-300"
              style={{ width: `${indexPercent ?? 0}%` }}
            />
          </div>
        </div>
      )}

      {/* File tree */}
      <div className="flex-1 overflow-y-auto py-1">
        {files.length === 0 ? (
          <p className="px-3 py-2 text-xs text-[#5a5a5a]">No files found</p>
        ) : (
          files.map((node) => (
            <TreeNode
              key={node.path}
              node={node}
              depth={0}
              activeFile={activeFile}
              onFileClick={handleFileClick}
            />
          ))
        )}
      </div>
    </div>
  );
};

// ── TreeNode ──────────────────────────────────────────────────────────────────

type TreeNodeProps = {
  node: FileNode;
  depth: number;
  activeFile: string | null;
  onFileClick: (node: FileNode) => void;
};

const TreeNode: React.FC<TreeNodeProps> = ({ node, depth, activeFile, onFileClick }) => {
  const [open, setOpen] = useState<boolean>(true);

  if (node.type === 'folder') {
    return (
      <div>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          style={{ paddingLeft: depth * 12 + 8 }}
          className="w-full flex items-center gap-1.5 py-1 pr-2 text-left hover:bg-[#2a2a2a] rounded transition-colors"
        >
          <span className="text-[#6a6a6a] shrink-0">
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
          <span className="text-[#6a6a6a] shrink-0">
            {open ? <FolderOpen size={13} /> : <Folder size={13} />}
          </span>
          <span className="text-xs text-[#c4c4c4] truncate">{node.name}</span>
        </button>
        {open && node.children?.map((child) => (
          <TreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            activeFile={activeFile}
            onFileClick={onFileClick}
          />
        ))}
      </div>
    );
  }

  const isActive = node.path === activeFile;

  return (
    <button
      type="button"
      onClick={() => onFileClick(node)}
      style={{ paddingLeft: depth * 12 + 20 }}
      className={`w-full flex items-center gap-1.5 py-1 pr-2 text-left rounded transition-colors ${
        isActive ? 'bg-[#3a3a3a]' : 'hover:bg-[#2a2a2a]'
      }`}
    >
      <FileIcon fileType={node.fileType ?? ''} />
      <span className="text-xs text-[#d4d4d4] truncate">{node.name}</span>
    </button>
  );
};

// ── File type icon ────────────────────────────────────────────────────────────

const FileIcon: React.FC<{ fileType: string }> = ({ fileType }) => {
  const colors: Record<string, string> = {
    pdf:  '#f87171',
    md:   '#60a5fa',
    txt:  '#9ca3af',
    pptx: '#fb923c',
  };
  return (
    <FileText
      size={13}
      className="shrink-0"
      style={{ color: colors[fileType] ?? '#9ca3af' }}
    />
  );
};