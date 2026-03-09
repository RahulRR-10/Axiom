import {
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  FileText,
  Folder,
  FolderOpen,
  FolderInput,
  FolderPlus,
  PanelRight,
  Pencil,
  PlusCircle,
  Trash2,
  AppWindow,
  ClipboardCopy,
} from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import type { FileNode, IndexStatus } from '../../../shared/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Callback ref that keeps a fixed-position context menu within the viewport. */
const clampMenuRef = (el: HTMLDivElement | null) => {
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (rect.bottom > vh) el.style.top = `${Math.max(0, vh - rect.height)}px`;
  if (rect.right > vw) el.style.left = `${Math.max(0, vw - rect.width)}px`;
};

// ── Types ─────────────────────────────────────────────────────────────────────

type VaultSidebarProps = {
  onVaultOpen?: (vaultPath: string) => void;
  onFileOpen?: (filePath: string, fileType: string) => void;
};

// ── New Note Modal ────────────────────────────────────────────────────────────

type NewNoteModalProps = {
  targetFolder: string;
  onCancel: () => void;
  onCreate: (title: string) => void;
};

const NewNoteModal: React.FC<NewNoteModalProps> = ({ targetFolder, onCancel, onCreate }) => {
  const [title, setTitle] = useState('');

  const folderName = targetFolder.split(/[/\\]/).filter(Boolean).pop() ?? targetFolder;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;
    onCreate(trimmed);
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.5)',
      }}
      onClick={onCancel}
    >
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#252525',
          border: '1px solid #3a3a3a',
          borderRadius: '10px',
          padding: '20px',
          width: '320px',
          boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
        }}
      >
        <h3 style={{ margin: '0 0 4px', fontSize: '14px', fontWeight: 600, color: '#e4e4e4' }}>
          New Note
        </h3>
        <p style={{ margin: '0 0 12px', fontSize: '11px', color: '#6a6a6a' }}>
          in {folderName}/
        </p>
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Note title…"
          style={{
            width: '100%',
            padding: '8px 10px',
            borderRadius: '6px',
            border: '1px solid #3a3a3a',
            background: '#1a1a1a',
            color: '#d4d4d4',
            fontSize: '13px',
            outline: 'none',
            boxSizing: 'border-box',
          }}
        />
        <div style={{ display: 'flex', gap: '8px', marginTop: '12px', justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              padding: '5px 14px',
              borderRadius: '6px',
              border: '1px solid #3a3a3a',
              background: 'transparent',
              color: '#8a8a8a',
              fontSize: '12px',
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            style={{
              padding: '5px 14px',
              borderRadius: '6px',
              border: 'none',
              background: '#4a9eff',
              color: '#fff',
              fontSize: '12px',
              cursor: 'pointer',
              fontWeight: 500,
            }}
          >
            Create
          </button>
        </div>
      </form>
    </div>
  );
};

// ── New Folder Modal ──────────────────────────────────────────────────────────

type NewFolderModalProps = {
  targetFolder: string;
  onCancel: () => void;
  onCreate: (name: string) => void;
};

const NewFolderModal: React.FC<NewFolderModalProps> = ({ targetFolder, onCancel, onCreate }) => {
  const [name, setName] = useState('');

  const folderName = targetFolder.split(/[/\\]/).filter(Boolean).pop() ?? targetFolder;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    onCreate(trimmed);
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.5)',
      }}
      onClick={onCancel}
    >
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#252525',
          border: '1px solid #3a3a3a',
          borderRadius: '10px',
          padding: '20px',
          width: '320px',
          boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
        }}
      >
        <h3 style={{ margin: '0 0 4px', fontSize: '14px', fontWeight: 600, color: '#e4e4e4' }}>
          New Folder
        </h3>
        <p style={{ margin: '0 0 12px', fontSize: '11px', color: '#6a6a6a' }}>
          in {folderName}/
        </p>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Folder name…"
          style={{
            width: '100%',
            padding: '8px 10px',
            borderRadius: '6px',
            border: '1px solid #3a3a3a',
            background: '#1a1a1a',
            color: '#d4d4d4',
            fontSize: '13px',
            outline: 'none',
            boxSizing: 'border-box',
          }}
        />
        <div style={{ display: 'flex', gap: '8px', marginTop: '12px', justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              padding: '5px 14px',
              borderRadius: '6px',
              border: '1px solid #3a3a3a',
              background: 'transparent',
              color: '#8a8a8a',
              fontSize: '12px',
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            style={{
              padding: '5px 14px',
              borderRadius: '6px',
              border: 'none',
              background: '#4a9eff',
              color: '#fff',
              fontSize: '12px',
              cursor: 'pointer',
              fontWeight: 500,
            }}
          >
            Create
          </button>
        </div>
      </form>
    </div>
  );
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Flatten all file-type nodes from the tree into a depth-first ordered array of paths. */
function flattenFilePaths(nodes: FileNode[]): string[] {
  const result: string[] = [];
  for (const node of nodes) {
    if (node.type === 'file') result.push(node.path);
    if (node.children) result.push(...flattenFilePaths(node.children));
  }
  return result;
}

// ── Component ─────────────────────────────────────────────────────────────────

export const VaultSidebar: React.FC<VaultSidebarProps> = ({ onVaultOpen, onFileOpen }) => {
  const [vaultPath, setVaultPath] = useState<string | null>(null);
  const [files, setFiles] = useState<FileNode[]>([]);
  const [indexStatus, setIndexStatus] = useState<IndexStatus | null>(null);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [lastClickedPath, setLastClickedPath] = useState<string | null>(null);
  const [newNoteFolder, setNewNoteFolder] = useState<string | null>(null);
  const [newFolderParent, setNewFolderParent] = useState<string | null>(null);
  const [emptySpaceMenu, setEmptySpaceMenu] = useState<{ x: number; y: number } | null>(null);

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
    window.electronAPI.setLastVault(selected);
  }, [onVaultOpen]);

  // Allow external trigger (e.g. header "Open Vault" button) via custom event
  useEffect(() => {
    const handler = (): void => { void handleOpenVault(); };
    window.addEventListener('triggerOpenVault', handler);
    return () => window.removeEventListener('triggerOpenVault', handler);
  }, [handleOpenVault]);

  // Auto-open last vault on startup
  useEffect(() => {
    void (async () => {
      const lastVault = await window.electronAPI.getLastVault();
      if (!lastVault) return;
      try {
        const { files: tree, status } = await window.electronAPI.openVault(lastVault);
        setVaultPath(lastVault);
        setFiles(tree);
        setIndexStatus(status);
        onVaultOpen?.(lastVault);
      } catch {
        // Vault directory may have been deleted — ignore and let user pick a new one
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function refreshTree(vp: string): Promise<void> {
    const tree = await window.electronAPI.readDirectory(vp);
    setFiles(tree);
  }

  const handleFileClick = useCallback((node: FileNode, shiftKey = false, ctrlKey = false) => {
    if (shiftKey && lastClickedPath) {
      const allPaths = flattenFilePaths(files);
      const fromIdx = allPaths.indexOf(lastClickedPath);
      const toIdx = allPaths.indexOf(node.path);
      if (fromIdx !== -1 && toIdx !== -1) {
        const [s, e] = fromIdx < toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx];
        setSelectedPaths(new Set(allPaths.slice(s, e + 1)));
      }
    } else if (ctrlKey) {
      setSelectedPaths(prev => {
        const next = new Set(prev);
        if (next.has(node.path)) next.delete(node.path);
        else next.add(node.path);
        return next;
      });
      setLastClickedPath(node.path);
    } else {
      setSelectedPaths(new Set([node.path]));
      setLastClickedPath(node.path);
      setActiveFile(node.path);
      onFileOpen?.(node.path, node.fileType ?? 'txt');
      window.dispatchEvent(
        new CustomEvent('openFile', { detail: { filePath: node.path, fileType: node.fileType } }),
      );
    }
  }, [files, lastClickedPath, onFileOpen]);

  // ── New Note handler ──────────────────────────────────────────────────────
  const handleNewNote = useCallback(() => {
    if (!vaultPath) return;
    setNewNoteFolder(vaultPath);
  }, [vaultPath]);

  // Listen for newNote event from the + button
  useEffect(() => {
    const handler = (): void => { handleNewNote(); };
    window.addEventListener('newNote', handler);
    return () => window.removeEventListener('newNote', handler);
  }, [handleNewNote]);

  const handleCreateNote = useCallback(async (title: string) => {
    if (!vaultPath || !newNoteFolder) return;
    try {
      const note = await window.electronAPI.createNote(vaultPath, newNoteFolder, title);
      setNewNoteFolder(null);
      // Refresh tree
      await refreshTree(vaultPath);
      // Open the created note — pass fileId so Workspace doesn't need to query for it
      if (note.file_path) {
        window.dispatchEvent(
          new CustomEvent('openFile', { detail: { filePath: note.file_path, fileType: 'md', fileId: note.id } }),
        );
      }
    } catch (err) {
      console.error('[VaultSidebar] Failed to create note:', err);
      setNewNoteFolder(null);
    }
  }, [vaultPath, newNoteFolder]);

  // ── New Folder handler ──────────────────────────────────────────────────
  const handleCreateFolder = useCallback(async (name: string) => {
    if (!vaultPath || !newFolderParent) return;
    try {
      const sep = newFolderParent.includes('/') ? '/' : '\\';
      const folderPath = `${newFolderParent}${sep}${name}`;
      await window.electronAPI.createFolder(folderPath);
      setNewFolderParent(null);
      await refreshTree(vaultPath);
    } catch (err) {
      console.error('[VaultSidebar] Failed to create folder:', err);
      setNewFolderParent(null);
    }
  }, [vaultPath, newFolderParent]);

  // ── Delete key handler ─────────────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Delete') return;
      const active = document.activeElement as HTMLElement;
      if (active?.tagName === 'INPUT' || active?.tagName === 'TEXTAREA') return;
      if (selectedPaths.size === 0) return;
      const ok = window.confirm(`Move ${selectedPaths.size} item(s) to trash?`);
      if (!ok) return;
      void (async () => {
        for (const path of Array.from(selectedPaths)) {
          try {
            await window.electronAPI.deleteFile(path);
          } catch (err) {
            console.error('[VaultSidebar] Delete failed:', path, err);
          }
        }
        setSelectedPaths(new Set());
        if (vaultPath) await refreshTree(vaultPath);
      })();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedPaths, vaultPath]);

  // ── Empty space context menu dismiss ──────────────────────────────────
  useEffect(() => {
    if (!emptySpaceMenu) return;
    const dismiss = () => setEmptySpaceMenu(null);
    window.addEventListener('click', dismiss);
    return () => window.removeEventListener('click', dismiss);
  }, [emptySpaceMenu]);

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

      {/* Vault name */}
      <div className="px-2 py-1.5 flex items-center justify-between border-b border-[#2a2a2a]">
        <span className="text-xs font-semibold text-[#d4d4d4] truncate" title={vaultPath}>
          {vaultName}
        </span>
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

      {/* File tree — right-click empty space for context menu */}
      <div
        className="flex-1 overflow-y-auto py-1"
        onContextMenu={(e) => {
          // Only show if right-clicking actual empty space (not a file/folder)
          if ((e.target as HTMLElement).closest('[data-tree-node]')) return;
          e.preventDefault();
          window.dispatchEvent(new Event('dismissFileCtxMenu'));
          setEmptySpaceMenu({ x: e.clientX, y: e.clientY });
        }}
        onClick={(e) => {
          if (!(e.target as HTMLElement).closest('[data-tree-node]')) {
            setSelectedPaths(new Set());
          }
        }}
        // Drop target for root vault area
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (!vaultPath) return;
          const multiPathsStr = e.dataTransfer.getData('text/vault-paths');
          if (multiPathsStr) {
            let paths: string[] = [];
            try { paths = JSON.parse(multiPathsStr) as string[]; } catch { return; }
            void (async () => {
              for (const srcPath of paths) {
                try {
                  await window.electronAPI.moveFile(srcPath, vaultPath);
                } catch (err) {
                  console.error('[VaultSidebar] Multi-drop to root failed:', err);
                }
              }
              await refreshTree(vaultPath);
            })();
            return;
          }
          const srcPath = e.dataTransfer.getData('text/vault-path');
          if (!srcPath) return;
          // Move to vault root
          void (async () => {
            try {
              await window.electronAPI.moveFile(srcPath, vaultPath);
              await refreshTree(vaultPath);
            } catch (err) {
              console.error('[VaultSidebar] Drop to root failed:', err);
            }
          })();
        }}
      >
        {files.length === 0 ? (
          <p className="px-3 py-2 text-xs text-[#5a5a5a]">No files found</p>
        ) : (
          files.map((node) => (
            <TreeNode
              key={node.path}
              node={node}
              depth={0}
              activeFile={activeFile}
              vaultPath={vaultPath}
              selectedPaths={selectedPaths}
              onFileClick={handleFileClick}
              onNewNoteInFolder={(folderPath) => setNewNoteFolder(folderPath)}
              onNewFolderInFolder={(folderPath) => setNewFolderParent(folderPath)}
              onTreeChanged={() => void refreshTree(vaultPath)}
            />
          ))
        )}
      </div>

      {/* Empty space context menu */}
      {emptySpaceMenu && (
        <div
          ref={clampMenuRef}
          style={{
            position: 'fixed',
            top: emptySpaceMenu.y,
            left: emptySpaceMenu.x,
            zIndex: 9998,
            background: '#2d2d2d',
            border: '1px solid #444',
            borderRadius: '6px',
            padding: '4px 0',
            boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
            minWidth: '160px',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              setEmptySpaceMenu(null);
              setNewNoteFolder(vaultPath);
            }}
            className="w-full text-left px-3 py-1.5 text-xs text-[#d4d4d4] hover:bg-[#3a3a3a] transition-colors flex items-center gap-2"
          >
            <PlusCircle size={12} />
            New Note
          </button>
          <button
            type="button"
            onClick={() => {
              setEmptySpaceMenu(null);
              setNewFolderParent(vaultPath);
            }}
            className="w-full text-left px-3 py-1.5 text-xs text-[#d4d4d4] hover:bg-[#3a3a3a] transition-colors flex items-center gap-2"
          >
            <FolderPlus size={12} />
            New Folder
          </button>
        </div>
      )}

      {/* New Note Modal */}
      {newNoteFolder && (
        <NewNoteModal
          targetFolder={newNoteFolder}
          onCancel={() => setNewNoteFolder(null)}
          onCreate={(title) => void handleCreateNote(title)}
        />
      )}

      {/* New Folder Modal */}
      {newFolderParent && (
        <NewFolderModal
          targetFolder={newFolderParent}
          onCancel={() => setNewFolderParent(null)}
          onCreate={(name) => void handleCreateFolder(name)}
        />
      )}
    </div>
  );
};

// ── TreeNode ──────────────────────────────────────────────────────────────────

type TreeNodeProps = {
  node: FileNode;
  depth: number;
  activeFile: string | null;
  vaultPath: string;
  selectedPaths: Set<string>;
  onFileClick: (node: FileNode, shiftKey: boolean, ctrlKey: boolean) => void;
  onNewNoteInFolder?: (folderPath: string) => void;
  onNewFolderInFolder?: (folderPath: string) => void;
  onTreeChanged?: () => void;
};

const TreeNode: React.FC<TreeNodeProps> = ({ node, depth, activeFile, vaultPath, selectedPaths, onFileClick, onNewNoteInFolder, onNewFolderInFolder, onTreeChanged }) => {
  const [open, setOpen] = useState<boolean>(true);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [showCopyPathSub, setShowCopyPathSub] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const renameRef = useRef<HTMLInputElement>(null);
  const [dropTarget, setDropTarget] = useState(false);

  // Close context menu on outside click or when another file opens its menu
  useEffect(() => {
    if (!ctxMenu) return;
    const dismiss = () => { setCtxMenu(null); setShowCopyPathSub(false); };
    window.addEventListener('click', dismiss);
    window.addEventListener('dismissFileCtxMenu', dismiss);
    return () => {
      window.removeEventListener('click', dismiss);
      window.removeEventListener('dismissFileCtxMenu', dismiss);
    };
  }, [ctxMenu]);

  // Focus rename input
  useEffect(() => {
    if (renaming && renameRef.current) {
      renameRef.current.focus();
      const dotIdx = renameValue.lastIndexOf('.');
      renameRef.current.setSelectionRange(0, dotIdx > 0 ? dotIdx : renameValue.length);
    }
  }, [renaming]);

  const commitRename = async () => {
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === node.name) { setRenaming(false); return; }
    try {
      await window.electronAPI.renameFile(node.path, trimmed);
      onTreeChanged?.();
    } catch (err) {
      console.error('[VaultSidebar] Rename failed:', err);
    }
    setRenaming(false);
  };

  // ── Drag handlers ──────────────────────────────────────────────────────
  const handleDragStart = (e: React.DragEvent) => {
    if (selectedPaths.has(node.path) && selectedPaths.size > 1) {
      e.dataTransfer.setData('text/vault-paths', JSON.stringify(Array.from(selectedPaths)));
    } else {
      e.dataTransfer.setData('text/vault-path', node.path);
    }
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleFolderDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    setDropTarget(true);
  };

  const handleFolderDragLeave = () => {
    setDropTarget(false);
  };

  const handleFolderDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(false);
    const multiPathsStr = e.dataTransfer.getData('text/vault-paths');
    if (multiPathsStr) {
      let paths: string[] = [];
      try { paths = JSON.parse(multiPathsStr) as string[]; } catch { return; }
      void (async () => {
        for (const srcPath of paths) {
          if (srcPath === node.path || node.path.startsWith(srcPath)) continue;
          try {
            await window.electronAPI.moveFile(srcPath, node.path);
          } catch (err) {
            console.error('[VaultSidebar] Multi-drop failed:', err);
          }
        }
        onTreeChanged?.();
      })();
      return;
    }
    const srcPath = e.dataTransfer.getData('text/vault-path');
    if (!srcPath || srcPath === node.path) return;
    // Don't drop a folder into itself or its own subfolder
    if (node.path.startsWith(srcPath)) return;
    void (async () => {
      try {
        await window.electronAPI.moveFile(srcPath, node.path);
        onTreeChanged?.();
      } catch (err) {
        console.error('[VaultSidebar] Drop failed:', err);
      }
    })();
  };

  // ── File context menu actions ──────────────────────────────────────────
  const fileCtxActions = {
    openInNewTab: () => {
      window.dispatchEvent(new CustomEvent('openFile', { detail: { filePath: node.path, fileType: node.fileType } }));
    },
    openToRight: () => {
      window.dispatchEvent(new CustomEvent('openFileToRight', { detail: { filePath: node.path, fileType: node.fileType } }));
    },
    openInNewWindow: () => {
      void window.electronAPI.openNewWindow(node.path, node.fileType ?? 'txt', vaultPath);
    },
    makeCopy: async () => {
      await window.electronAPI.makeCopy(node.path);
      onTreeChanged?.();
    },
    moveFileTo: async () => {
      const dest = await window.electronAPI.selectFolder(vaultPath);
      if (!dest) return;
      try {
        await window.electronAPI.moveFile(node.path, dest);
        onTreeChanged?.();
      } catch (err) {
        console.error('[VaultSidebar] Move failed:', err);
      }
    },
    copyVaultRelativePath: () => {
      const rel = node.path.startsWith(vaultPath)
        ? node.path.slice(vaultPath.length).replace(/^[\\/]/, '')
        : node.path;
      navigator.clipboard.writeText(rel);
    },
    copySystemPath: () => {
      navigator.clipboard.writeText(node.path);
    },
    openInDefaultApp: () => {
      window.electronAPI.openExternal(node.path);
    },
    showInExplorer: () => {
      window.electronAPI.showItemInFolder(node.path);
    },
    startRename: () => {
      setRenameValue(node.name);
      setRenaming(true);
    },
    deleteFile: async () => {
      const ok = window.confirm(`Move "${node.name}" to trash?`);
      if (!ok) return;
      try {
        await window.electronAPI.deleteFile(node.path);
        onTreeChanged?.();
      } catch (err) {
        console.error('[VaultSidebar] Delete failed:', err);
      }
    },
  };

  // ── Shared context-menu dropdown UI ────────────────────────────────────
  const renderFileContextMenu = () => {
    if (!ctxMenu) return null;

    const sep = <div style={{ height: 1, background: '#3a3a3a', margin: '4px 0' }} />;
    const item = (label: string, icon: React.ReactNode, onClick: () => void, danger = false) => (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setCtxMenu(null); setShowCopyPathSub(false); onClick(); }}
        className="w-full text-left px-3 py-1.5 text-xs hover:bg-[#3a3a3a] transition-colors flex items-center gap-2"
        style={{ color: danger ? '#f87171' : '#d4d4d4' }}
      >
        {icon}
        {label}
      </button>
    );

    return (
      <div
        ref={clampMenuRef}
        style={{
          position: 'fixed',
          top: ctxMenu.y,
          left: ctxMenu.x,
          zIndex: 9998,
          background: '#2d2d2d',
          border: '1px solid #444',
          borderRadius: '6px',
          padding: '4px 0',
          boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
          minWidth: '200px',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {item('Open in new tab', <ExternalLink size={12} />, fileCtxActions.openInNewTab)}
        {item('Open to the right', <PanelRight size={12} />, fileCtxActions.openToRight)}
        {item('Open in new window', <AppWindow size={12} />, fileCtxActions.openInNewWindow)}
        {sep}
        {item('Make a copy', <Copy size={12} />, () => void fileCtxActions.makeCopy())}
        {item('Move file to…', <FolderInput size={12} />, () => void fileCtxActions.moveFileTo())}
        {sep}

        {/* Copy path sub-menu */}
        <div
          className="relative"
          onMouseEnter={() => setShowCopyPathSub(true)}
          onMouseLeave={() => setShowCopyPathSub(false)}
        >
          <button
            type="button"
            className="w-full text-left px-3 py-1.5 text-xs text-[#d4d4d4] hover:bg-[#3a3a3a] transition-colors flex items-center gap-2"
            onClick={(e) => { e.stopPropagation(); setShowCopyPathSub((v) => !v); }}
          >
            <ClipboardCopy size={12} />
            Copy path
            <ChevronRight size={10} className="ml-auto text-[#6a6a6a]" />
          </button>

          {showCopyPathSub && (
            <div
              style={{
                position: 'absolute',
                top: 0,
                left: '100%',
                marginLeft: 2,
                background: '#2d2d2d',
                border: '1px solid #444',
                borderRadius: '6px',
                padding: '4px 0',
                boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
                minWidth: '180px',
                zIndex: 9999,
              }}
            >
              {item('Vault relative path', null, () => { fileCtxActions.copyVaultRelativePath(); setShowCopyPathSub(false); })}
              {item('System absolute path', null, () => { fileCtxActions.copySystemPath(); setShowCopyPathSub(false); })}
            </div>
          )}
        </div>

        {sep}
        {item('Open in default app', <ExternalLink size={12} />, fileCtxActions.openInDefaultApp)}
        {item('Show in system explorer', <FolderOpen size={12} />, fileCtxActions.showInExplorer)}
        {sep}
        {item('Rename', <Pencil size={12} />, fileCtxActions.startRename)}
        {item('Delete', <Trash2 size={12} />, () => void fileCtxActions.deleteFile(), true)}
      </div>
    );
  };

  if (node.type === 'folder') {
    return (
      <div data-tree-node>
        <button
          type="button"
          draggable
          onDragStart={handleDragStart}
          onDragOver={handleFolderDragOver}
          onDragLeave={handleFolderDragLeave}
          onDrop={handleFolderDrop}
          onClick={() => setOpen((o) => !o)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            window.dispatchEvent(new Event('dismissFileCtxMenu'));
            setCtxMenu({ x: e.clientX, y: e.clientY });
          }}
          style={{
            paddingLeft: depth * 12 + 8,
            background: dropTarget ? 'rgba(74, 158, 255, 0.15)' : undefined,
            borderLeft: dropTarget ? '2px solid #4a9eff' : '2px solid transparent',
          }}
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

        {/* Right-click context menu */}
        {ctxMenu && (
          <div
            ref={clampMenuRef}
            style={{
              position: 'fixed',
              top: ctxMenu.y,
              left: ctxMenu.x,
              zIndex: 9998,
              background: '#2d2d2d',
              border: '1px solid #444',
              borderRadius: '6px',
              padding: '4px 0',
              boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
              minWidth: '160px',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => {
                setCtxMenu(null);
                onNewNoteInFolder?.(node.path);
              }}
              className="w-full text-left px-3 py-1.5 text-xs text-[#d4d4d4] hover:bg-[#3a3a3a] transition-colors flex items-center gap-2"
            >
              <PlusCircle size={12} />
              New Note
            </button>
            <button
              type="button"
              onClick={() => {
                setCtxMenu(null);
                onNewFolderInFolder?.(node.path);
              }}
              className="w-full text-left px-3 py-1.5 text-xs text-[#d4d4d4] hover:bg-[#3a3a3a] transition-colors flex items-center gap-2"
            >
              <FolderPlus size={12} />
              New Folder
            </button>
            <div style={{ height: 1, background: '#3a3a3a', margin: '4px 0' }} />
            <button
              type="button"
              onClick={() => {
                setCtxMenu(null);
                setRenameValue(node.name);
                setRenaming(true);
              }}
              className="w-full text-left px-3 py-1.5 text-xs text-[#d4d4d4] hover:bg-[#3a3a3a] transition-colors flex items-center gap-2"
            >
              <Pencil size={12} />
              Rename
            </button>
            <button
              type="button"
              onClick={async () => {
                setCtxMenu(null);
                const ok = window.confirm(`Move "${node.name}" to trash?`);
                if (!ok) return;
                try {
                  await window.electronAPI.deleteFile(node.path);
                  onTreeChanged?.();
                } catch (err) {
                  console.error('[VaultSidebar] Delete folder failed:', err);
                }
              }}
              className="w-full text-left px-3 py-1.5 text-xs text-[#f87171] hover:bg-[#3a3a3a] transition-colors flex items-center gap-2"
            >
              <Trash2 size={12} />
              Delete
            </button>
          </div>
        )}

        {/* Inline rename for folder */}
        {renaming && (
          <div style={{ paddingLeft: depth * 12 + 20 }} className="flex items-center gap-1.5 py-0.5 pr-2">
            <Folder size={13} className="shrink-0 text-[#6a6a6a]" />
            <input
              ref={renameRef}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commitRename();
                if (e.key === 'Escape') setRenaming(false);
              }}
              onBlur={() => void commitRename()}
              style={{
                flex: 1,
                padding: '1px 4px',
                borderRadius: '3px',
                border: '1px solid #4a9eff',
                background: '#1a1a1a',
                color: '#d4d4d4',
                fontSize: '12px',
                outline: 'none',
              }}
            />
          </div>
        )}

        {open && node.children?.map((child) => (
          <TreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            activeFile={activeFile}
            vaultPath={vaultPath}
            selectedPaths={selectedPaths}
            onFileClick={onFileClick}
            onNewNoteInFolder={onNewNoteInFolder}
            onNewFolderInFolder={onNewFolderInFolder}
            onTreeChanged={onTreeChanged}
          />
        ))}
      </div>
    );
  }

  const isActive = node.path === activeFile;

  // Inline rename mode
  if (renaming) {
    return (
      <div data-tree-node style={{ paddingLeft: depth * 12 + 20 }} className="flex items-center gap-1.5 py-0.5 pr-2">
        <FileIcon fileType={node.fileType ?? ''} />
        <input
          ref={renameRef}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commitRename();
            if (e.key === 'Escape') setRenaming(false);
          }}
          onBlur={() => void commitRename()}
          style={{
            flex: 1,
            padding: '1px 4px',
            borderRadius: '3px',
            border: '1px solid #4a9eff',
            background: '#1a1a1a',
            color: '#d4d4d4',
            fontSize: '12px',
            outline: 'none',
          }}
        />
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        data-tree-node
        draggable
        onDragStart={handleDragStart}
        onClick={(e) => onFileClick(node, e.shiftKey, e.ctrlKey || e.metaKey)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          window.dispatchEvent(new Event('dismissFileCtxMenu'));
          setCtxMenu({ x: e.clientX, y: e.clientY });
        }}
        style={{ paddingLeft: depth * 12 + 20 }}
        className={`w-full flex items-center gap-1.5 py-1 pr-2 text-left rounded transition-colors ${
          selectedPaths.has(node.path) ? 'bg-[#1e3a5f]' : isActive ? 'bg-[#3a3a3a]' : 'hover:bg-[#2a2a2a]'
        }`}
      >
        <FileIcon fileType={node.fileType ?? ''} />
        <span className="text-xs text-[#d4d4d4] truncate">{node.name}</span>
      </button>

      {renderFileContextMenu()}
    </>
  );
};

// ── File type icon ────────────────────────────────────────────────────────────

const FileIcon: React.FC<{ fileType: string }> = ({ fileType }) => {
  const colors: Record<string, string> = {
    pdf: '#f87171',
    md: '#60a5fa',
    txt: '#9ca3af',
    pptx: '#fb923c',
    png: '#a78bfa',
    jpg: '#a78bfa',
    jpeg: '#a78bfa',
    gif: '#a78bfa',
    webp: '#a78bfa',
    svg: '#a78bfa',
    bmp: '#a78bfa',
  };
  return (
    <FileText
      size={13}
      className="shrink-0"
      style={{ color: colors[fileType] ?? '#9ca3af' }}
    />
  );
};