import { FileText, Search } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import type { SpotlightResult } from '../../../shared/types';

type SpotlightSearchProps = {
  vaultPath: string | null;
};

const FILE_COLORS: Record<string, string> = {
  pdf:  '#f87171',
  md:   '#60a5fa',
  txt:  '#9ca3af',
  pptx: '#fb923c',
};

export const SpotlightSearch: React.FC<SpotlightSearchProps> = ({ vaultPath }) => {
  const [open, setOpen]       = useState<boolean>(false);
  const [query, setQuery]     = useState<string>('');
  const [results, setResults] = useState<SpotlightResult[]>([]);
  const [cursor, setCursor]   = useState<number>(0);

  const inputRef  = useRef<HTMLInputElement>(null);
  const debounce  = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Open/close on spotlight:open event and escape ────────────────────────
  useEffect(() => {
    const onOpen = (): void => {
      setOpen(true);
      setQuery('');
      setResults([]);
      setCursor(0);
    };
    window.addEventListener('spotlight:open', onOpen);
    return () => window.removeEventListener('spotlight:open', onOpen);
  }, []);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // ── Debounced search on every query change ────────────────────────────────
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    if (!query.trim() || !vaultPath) {
      setResults([]);
      return;
    }
    debounce.current = setTimeout(() => {
      window.electronAPI
        .spotlightSearch(query, vaultPath)
        .then((res) => { setResults(res); setCursor(0); })
        .catch(console.error);
    }, 150);
  }, [query, vaultPath]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setResults([]);
  }, []);

  const openResult = useCallback((result: SpotlightResult) => {
    if (result.file_id) {
      window.dispatchEvent(
        new CustomEvent('openFile', {
          detail: { filePath: result.file_name, fileType: result.file_type, page: result.page_or_slide },
        }),
      );
    }
    close();
  }, [close]);

  // ── Keyboard navigation ───────────────────────────────────────────────────
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape') { close(); return; }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setCursor((c) => Math.min(c + 1, results.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setCursor((c) => Math.max(c - 1, 0));
      } else if (e.key === 'Enter' && results[cursor]) {
        openResult(results[cursor]);
      }
    },
    [results, cursor, close, openResult],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
      style={{ background: 'rgba(0,0,0,0.7)' }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <div
        className="w-[600px] rounded-xl overflow-hidden"
        style={{
          background:  '#1e1e1e',
          border:      '1px solid #3a3a3a',
          boxShadow:   '0 16px 48px rgba(0,0,0,0.8)',
        }}
      >
        {/* Search input */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[#2a2a2a]">
          <Search size={16} className="text-[#6a6a6a] shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={vaultPath ? 'Search your vault…' : 'Open a vault first (Vault → Open Vault)'}
            disabled={!vaultPath}
            className="flex-1 bg-transparent text-[#d4d4d4] text-sm outline-none placeholder-[#4a4a4a]"
          />
          <kbd className="text-[10px] text-[#5a5a5a] border border-[#3a3a3a] rounded px-1">Esc</kbd>
        </div>

        {/* Results */}
        {results.length > 0 && (
          <ul className="max-h-[360px] overflow-y-auto py-1">
            {results.map((r, i) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => openResult(r)}
                  onMouseEnter={() => setCursor(i)}
                  className={`w-full flex items-start gap-3 px-4 py-2.5 text-left transition-colors ${
                    i === cursor ? 'bg-[#2a2a2a]' : 'hover:bg-[#252525]'
                  }`}
                >
                  <FileText
                    size={14}
                    className="mt-0.5 shrink-0"
                    style={{ color: FILE_COLORS[r.file_type] ?? '#9ca3af' }}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-[#d4d4d4] truncate">
                        {r.file_name}
                      </span>
                      {r.subject && (
                        <span className="text-[10px] text-[#6a6a6a] border border-[#3a3a3a] rounded px-1 shrink-0">
                          {r.subject}
                        </span>
                      )}
                      {r.page_or_slide != null && (
                        <span className="text-[10px] text-[#5a5a5a] shrink-0">
                          p.{r.page_or_slide}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-[#7a7a7a] truncate mt-0.5">{r.snippet}</p>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* Empty state */}
        {query.trim() && results.length === 0 && (
          <p className="px-4 py-6 text-xs text-[#5a5a5a] text-center">
            No results for <span className="text-[#8a8a8a]">"{query}"</span>
          </p>
        )}
      </div>
    </div>
  );
};
