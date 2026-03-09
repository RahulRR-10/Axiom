import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Check, AlertTriangle } from 'lucide-react';
import type { NoteSummary } from '../../../shared/types';

// ── Session default (module-level — survives re-renders and tab switches) ────
let _sessionDefaultNoteId: string | null = null;
let _sessionVaultPath: string | null = null;

export function getSessionDefault(): string | null {
  return _sessionDefaultNoteId;
}

export function setSessionDefault(noteId: string, vaultPath: string): void {
  _sessionDefaultNoteId = noteId;
  _sessionVaultPath = vaultPath;
}

export function clearSessionDefault(): void {
  _sessionDefaultNoteId = null;
  _sessionVaultPath = null;
}

/** Call on every render / vault change to auto-clear when vault switches */
export function syncSessionVault(vaultPath: string | null): void {
  if (vaultPath && _sessionVaultPath && vaultPath !== _sessionVaultPath) {
    clearSessionDefault();
  }
}

// ── Component ────────────────────────────────────────────────────────────────

type Props = {
  vaultPath: string;
  sourceSubject: string | null;
  selectedText: string;
  sourceFile: string;
  sourcePage: number;
  onSaved: (noteTitle: string) => void;
  onDeleted: () => void;
  onClose: () => void;
};

export const NotePickerPopover: React.FC<Props> = ({
  vaultPath,
  sourceSubject,
  selectedText,
  sourceFile,
  sourcePage,
  onSaved,
  onDeleted,
  onClose,
}) => {
  const [notes, setNotes] = useState<NoteSummary[] | null>(null);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const [saving, setSaving] = useState(false);
  const [duplicateWarning, setDuplicateWarning] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // ── Build ranked note list ────────────────────────────────────────────────
  // Order: session default → same subject as source → recently edited. Max 4.
  const rankedNotes = useCallback(
    (allNotes: NoteSummary[]): NoteSummary[] => {
      const sessionId = getSessionDefault();
      const result: NoteSummary[] = [];
      const seen = new Set<string>();

      // 1. Session default (pinned)
      if (sessionId) {
        const pinned = allNotes.find(n => n.id === sessionId);
        if (pinned) {
          result.push(pinned);
          seen.add(pinned.id);
        }
      }

      // 2. Same subject as source file
      if (sourceSubject) {
        const subjectLower = sourceSubject.toLowerCase();
        for (const n of allNotes) {
          if (seen.has(n.id)) continue;
          if (n.subject && n.subject.toLowerCase() === subjectLower) {
            result.push(n);
            seen.add(n.id);
            if (result.length >= 4) break;
          }
        }
      }

      // 3. Recently edited (allNotes is already sorted by updated_at DESC from backend)
      for (const n of allNotes) {
        if (result.length >= 4) break;
        if (seen.has(n.id)) continue;
        result.push(n);
        seen.add(n.id);
      }

      return result;
    },
    [sourceSubject],
  );

  // ── Load notes on mount ────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const recent = await window.electronAPI.recentNotes(vaultPath);
        // Merge recent + full list for subject matching
        const all = await window.electronAPI.listNotes(vaultPath);
        // De-dupe (recent first since they're ordered by updated_at)
        const merged: NoteSummary[] = [];
        const seen = new Set<string>();
        for (const n of [...recent.notes, ...all]) {
          if (!seen.has(n.id)) {
            merged.push(n);
            seen.add(n.id);
          }
        }
        if (!cancelled) setNotes(merged);
      } catch (err) {
        console.error('[NotePickerPopover] load failed:', err);
        if (!cancelled) setNotes([]);
      }
    })();
    return () => { cancelled = true; };
  }, [vaultPath]);

  const ranked = notes ? rankedNotes(notes) : null;

  // ── Save handler ──────────────────────────────────────────────────────────
  const doSave = useCallback(
    async (noteId: string) => {
      if (saving) return;
      setSaving(true);
      setDuplicateWarning(false);
      try {
        const result = await window.electronAPI.appendChunk(
          vaultPath,
          noteId,
          selectedText,
          sourceFile,
          sourcePage,
        );

        if (!result.ok) {
          if (result.reason === 'deleted') {
            // Note was deleted — clear session default, notify parent
            if (getSessionDefault() === noteId) clearSessionDefault();
            onDeleted();
            return;
          }
          if (result.reason === 'write_failed') {
            // Write failure — show toast but keep session default
            window.dispatchEvent(
              new CustomEvent('noteSavedToast', {
                detail: { noteTitle: `Failed to save to ${result.noteTitle ?? 'note'}` },
              }),
            );
            onClose();
            return;
          }
          // not_found
          if (getSessionDefault() === noteId) clearSessionDefault();
          onDeleted();
          return;
        }

        // Success — set session default
        setSessionDefault(noteId, vaultPath);

        // Duplicate warning: show but don't block (already saved)
        if (result.duplicate) {
          setDuplicateWarning(true);
          setSaving(false);
          // Auto-close after a moment
          setTimeout(() => {
            onSaved(result.noteTitle ?? 'note');
          }, 1500);
          return;
        }

        onSaved(result.noteTitle ?? 'note');
      } catch (err) {
        console.error('[NotePickerPopover] save failed:', err);
      } finally {
        setSaving(false);
      }
    },
    [vaultPath, selectedText, sourceFile, sourcePage, saving, onSaved, onDeleted, onClose],
  );

  // ── Keyboard navigation ────────────────────────────────────────────────────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!ranked || ranked.length === 0) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlightIdx(i => Math.min(i + 1, ranked.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlightIdx(i => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        void doSave(ranked[highlightIdx].id);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [ranked, highlightIdx, doSave, onClose]);

  // Scroll highlighted item into view
  useEffect(() => {
    const el = listRef.current?.children[highlightIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [highlightIdx]);

  return (
    <div
      style={{
        position: 'absolute',
        top: '100%',
        right: 0,
        marginTop: 6,
        background: '#252525',
        border: '1px solid #3a3a3a',
        borderRadius: '10px',
        padding: '6px 0',
        minWidth: 220,
        maxWidth: 300,
        maxHeight: 260,
        zIndex: 1001,
        boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
        display: 'flex',
        flexDirection: 'column',
      }}
      onMouseDown={e => e.stopPropagation()}
      onMouseUp={e => e.stopPropagation()}
    >
      {/* Header */}
      <div
        style={{
          padding: '4px 12px 6px',
          fontSize: 10,
          color: '#7a7a7a',
          letterSpacing: '0.03em',
          borderBottom: '1px solid #333',
        }}
      >
        Save to note{' '}
        <span style={{ color: '#555' }}>(↑↓ Enter)</span>
      </div>

      {/* Duplicate warning */}
      {duplicateWarning && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 12px',
            fontSize: 11,
            color: '#eab308',
            background: '#2a2600',
          }}
        >
          <AlertTriangle size={12} />
          Duplicate text — saved anyway
        </div>
      )}

      {/* Note list */}
      <div ref={listRef} style={{ overflowY: 'auto', flex: 1 }}>
        {ranked === null && (
          <div style={{ padding: '10px 12px', fontSize: 11, color: '#666' }}>
            Loading…
          </div>
        )}
        {ranked !== null && ranked.length === 0 && (
          <div style={{ padding: '10px 12px', fontSize: 11, color: '#666' }}>
            No notes in vault
          </div>
        )}
        {ranked?.map((note, idx) => {
          const isSession = note.id === getSessionDefault();
          const isHighlighted = idx === highlightIdx;
          return (
            <button
              key={note.id}
              type="button"
              onClick={() => void doSave(note.id)}
              onMouseEnter={() => setHighlightIdx(idx)}
              disabled={saving}
              style={{
                display: 'flex',
                alignItems: 'center',
                width: '100%',
                padding: '6px 12px',
                fontSize: 12,
                color: isHighlighted ? '#e4e4e4' : '#b0b0b0',
                background: isHighlighted ? '#3a3a3a' : 'transparent',
                border: 'none',
                cursor: saving ? 'wait' : 'pointer',
                textAlign: 'left',
                gap: 6,
                transition: 'background 0.1s',
              }}
            >
              {isSession && <Check size={12} style={{ color: '#6366f1', flexShrink: 0 }} />}
              <span
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  flex: 1,
                }}
              >
                {note.title}
              </span>
              {isSession && (
                <span style={{ fontSize: 9, color: '#6366f1', flexShrink: 0 }}>
                  default
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
};
