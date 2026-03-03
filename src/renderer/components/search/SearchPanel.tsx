import { FileText, StickyNote, Search, Send, Star, Pen, ChevronDown, X } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { SearchResult } from '../../../shared/types';

// ── Types ────────────────────────────────────────────────────────────────────

type SearchPanelProps = {
  vaultPath: string | null;
};

type FilterState = {
  fileType: string; // 'all' | 'pdf' | 'md' | 'pptx' | 'txt'
  subject: string;  // 'all' | subject name
  sort: 'relevance' | 'date';
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const FILE_TYPE_ICONS: Record<string, React.ReactNode> = {
  pdf:  <FileText size={14} className="shrink-0 mt-0.5" style={{ color: '#f87171' }} />,
  md:   <StickyNote size={14} className="shrink-0 mt-0.5" style={{ color: '#60a5fa' }} />,
  pptx: <FileText size={14} className="shrink-0 mt-0.5" style={{ color: '#fb923c' }} />,
  txt:  <FileText size={14} className="shrink-0 mt-0.5" style={{ color: '#9ca3af' }} />,
};

const SUBJECT_COLORS = [
  '#818cf8', '#fb923c', '#34d399', '#f472b6', '#a78bfa',
  '#fbbf24', '#2dd4bf', '#f87171', '#38bdf8', '#a3e635',
];

function getSubjectColor(subject: string): string {
  let hash = 0;
  for (let i = 0; i < subject.length; i++) {
    hash = subject.charCodeAt(i) + ((hash << 5) - hash);
  }
  return SUBJECT_COLORS[Math.abs(hash) % SUBJECT_COLORS.length];
}

function boldMatchedTerms(text: string, query: string): React.ReactNode {
  if (!query.trim()) return text;
  const terms = query.trim().split(/\s+/).filter(Boolean);
  const pattern = new RegExp(
    `(${terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
    'gi',
  );
  const parts = text.split(pattern);
  return parts.map((part, i) =>
    pattern.test(part)
      ? <strong key={i} className="text-[#e4e4e4]">{part}</strong>
      : part,
  );
}

// ── Component ────────────────────────────────────────────────────────────────

export const SearchPanel: React.FC<SearchPanelProps> = ({ vaultPath }) => {
  const [open, setOpen]           = useState(false);
  const [query, setQuery]         = useState('');
  const [results, setResults]     = useState<SearchResult[]>([]);
  const [isSearching, setSearching] = useState(false);
  const [cursor, setCursor]       = useState(0);
  const [filters, setFilters]     = useState<FilterState>({
    fileType: 'all',
    subject: 'all',
    sort: 'relevance',
  });

  const inputRef = useRef<HTMLInputElement>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  // ── Open / close via spotlight:open event ──────────────────────────────
  useEffect(() => {
    const onOpen = (): void => {
      setOpen(true);
      setQuery('');
      setResults([]);
      setCursor(0);
      setFilters({ fileType: 'all', subject: 'all', sort: 'relevance' });
    };
    window.addEventListener('spotlight:open', onOpen);
    return () => window.removeEventListener('spotlight:open', onOpen);
  }, []);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  // ── Debounced search ──────────────────────────────────────────────────
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    if (!query.trim() || !vaultPath) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    debounce.current = setTimeout(() => {
      window.electronAPI
        .search(query, vaultPath)
        .then((res) => {
          setResults(res);
          setCursor(0);
          setSearching(false);
        })
        .catch((err) => {
          console.error('[search]', err);
          setSearching(false);
        });
    }, 200);
  }, [query, vaultPath]);

  // ── Derived data ──────────────────────────────────────────────────────
  const subjects = useMemo(() => {
    const set = new Set<string>();
    for (const r of results) { if (r.subject) set.add(r.subject); }
    return Array.from(set).sort();
  }, [results]);

  const filtered = useMemo(() => {
    let out = results;
    if (filters.fileType !== 'all') out = out.filter(r => r.file_type === filters.fileType);
    if (filters.subject !== 'all') out = out.filter(r => r.subject === filters.subject);
    return out;
  }, [results, filters]);

  // ── Actions ───────────────────────────────────────────────────────────
  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setResults([]);
  }, []);

  const openResult = useCallback((result: SearchResult) => {
    if (result.file_id) {
      window.dispatchEvent(
        new CustomEvent('openFile', {
          detail: {
            filePath: result.file_path,
            fileId: result.file_id,
            fileType: result.file_type,
            page: result.page_or_slide,
          },
        }),
      );
    }
    close();
  }, [close]);

  const sendToAi = useCallback((text: string) => {
    window.dispatchEvent(
      new CustomEvent('sendToAI', { detail: { text, target: 'claude' } }),
    );
  }, []);

  // ── Keyboard navigation ──────────────────────────────────────────────
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape') { close(); return; }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setCursor((c) => Math.min(c + 1, filtered.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setCursor((c) => Math.max(c - 1, 0));
      } else if (e.key === 'Enter' && filtered[cursor]) {
        openResult(filtered[cursor]);
      }
    },
    [filtered, cursor, close, openResult],
  );

  // Auto-scroll active item into view
  useEffect(() => {
    if (!resultsRef.current) return;
    const active = resultsRef.current.querySelector('[data-active="true"]');
    active?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  if (!open) return null;

  const hasFilters = filters.fileType !== 'all' || filters.subject !== 'all';

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]"
      style={{ background: 'rgba(0,0,0,0.7)' }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <div
        className="w-[660px] rounded-xl overflow-hidden flex flex-col"
        style={{
          background: '#1e1e1e',
          border: '1px solid #3a3a3a',
          boxShadow: '0 16px 48px rgba(0,0,0,0.8)',
          maxHeight: '70vh',
        }}
      >
        {/* ── Search input ── */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[#2a2a2a]">
          <Search size={16} className="text-[#6a6a6a] shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={vaultPath ? 'Search your vault…' : 'Open a vault first'}
            disabled={!vaultPath}
            className="flex-1 bg-transparent text-[#d4d4d4] text-sm outline-none placeholder-[#4a4a4a]"
          />
          {query && (
            <button
              type="button"
              onClick={() => { setQuery(''); inputRef.current?.focus(); }}
              className="text-[#5a5a5a] hover:text-[#aaa]"
              aria-label="Clear search"
            >
              <X size={14} />
            </button>
          )}
          <kbd className="text-[10px] text-[#5a5a5a] border border-[#3a3a3a] rounded px-1 shrink-0">Esc</kbd>
        </div>

        {/* ── Filters bar (only when results exist) ── */}
        {results.length > 0 && (
          <div className="flex items-center gap-2 px-4 py-2 border-b border-[#2a2a2a] flex-wrap">
            {/* File type */}
            <div className="relative">
              <select
                value={filters.fileType}
                onChange={(e) => setFilters(f => ({ ...f, fileType: e.target.value }))}
                className="appearance-none bg-[#252525] border border-[#333] rounded-md px-2.5 py-1 pr-6 text-[11px] text-[#bbb] outline-none cursor-pointer hover:border-[#444]"
              >
                <option value="all">All Types</option>
                <option value="pdf">PDFs</option>
                <option value="md">Notes</option>
                <option value="pptx">Slides</option>
                <option value="txt">Text</option>
              </select>
              <ChevronDown size={10} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[#666] pointer-events-none" />
            </div>

            {/* Subject */}
            {subjects.length > 0 && (
              <div className="relative">
                <select
                  value={filters.subject}
                  onChange={(e) => setFilters(f => ({ ...f, subject: e.target.value }))}
                  className="appearance-none bg-[#252525] border border-[#333] rounded-md px-2.5 py-1 pr-6 text-[11px] text-[#bbb] outline-none cursor-pointer hover:border-[#444]"
                >
                  <option value="all">All Subjects</option>
                  {subjects.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
                <ChevronDown size={10} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[#666] pointer-events-none" />
              </div>
            )}

            {/* Clear filters */}
            {hasFilters && (
              <button
                type="button"
                onClick={() => setFilters({ fileType: 'all', subject: 'all', sort: 'relevance' })}
                className="text-[10px] text-[#6a6a6a] hover:text-[#aaa]"
              >
                Clear filters
              </button>
            )}

            {/* Result count */}
            <span className="ml-auto text-[10px] text-[#5a5a5a]">
              {filtered.length} result{filtered.length !== 1 ? 's' : ''}
            </span>
          </div>
        )}

        {/* ── Results ── */}
        <div ref={resultsRef} className="flex-1 overflow-y-auto">
          {/* Loading */}
          {isSearching && (
            <div className="flex items-center justify-center py-10">
              <div className="w-4 h-4 border-2 border-[#3a3a3a] border-t-[#888] rounded-full animate-spin" />
            </div>
          )}

          {/* Empty state */}
          {!isSearching && query.trim() && filtered.length === 0 && (
            <p className="px-4 py-8 text-xs text-[#5a5a5a] text-center">
              No results for <span className="text-[#8a8a8a]">"{query}"</span>
            </p>
          )}

          {/* Result list */}
          {!isSearching && filtered.length > 0 && (
            <ul className="py-1">
              {filtered.map((r, idx) => (
                <li key={r.id + idx} data-active={idx === cursor ? 'true' : undefined}>
                  <button
                    type="button"
                    onClick={() => openResult(r)}
                    onMouseEnter={() => setCursor(idx)}
                    className={`w-full flex items-start gap-3 px-4 py-3 text-left transition-colors group ${
                      idx === cursor ? 'bg-[#2a2a2a]' : 'hover:bg-[#232323]'
                    }`}
                  >
                    {/* Icon */}
                    {FILE_TYPE_ICONS[r.file_type] ?? FILE_TYPE_ICONS.txt}

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        {/* File name */}
                        <span className="text-xs font-medium text-[#d4d4d4] truncate">
                          {r.file_name}
                        </span>

                        {/* Page badge */}
                        {r.page_or_slide != null && (
                          <span className="text-[10px] text-[#7a7a7a] bg-[#252525] rounded px-1.5 py-0.5 shrink-0">
                            Page {r.page_or_slide}
                          </span>
                        )}

                        {/* Subject badge */}
                        {r.subject && (
                          <span
                            className="text-[10px] rounded px-1.5 py-0.5 shrink-0"
                            style={{
                              color: getSubjectColor(r.subject),
                              border: `1px solid ${getSubjectColor(r.subject)}40`,
                              background: `${getSubjectColor(r.subject)}10`,
                            }}
                          >
                            {r.subject}
                          </span>
                        )}

                        {/* Top hit */}
                        {idx === 0 && (
                          <span className="flex items-center gap-0.5 text-[10px] text-amber-400 shrink-0">
                            <Star size={10} /> Top hit
                          </span>
                        )}

                        {/* Annotation badge */}
                        {r.is_annotation === 1 && (
                          <span className="flex items-center gap-0.5 text-[10px] text-[#818cf8] shrink-0">
                            <Pen size={10} /> You highlighted this
                          </span>
                        )}

                        {/* Note badge */}
                        {r.category === 'note' && (
                          <span className="text-[10px] text-[#60a5fa] shrink-0">Note</span>
                        )}
                      </div>

                      {/* Snippet — show text excerpt with bold matches */}
                      <p className="text-[11px] text-[#6a6a6a] mt-1 line-clamp-2 leading-relaxed">
                        {boldMatchedTerms(r.text.slice(0, 250), query)}
                      </p>
                    </div>

                    {/* Send to AI */}
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); sendToAi(r.text); }}
                      className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-md text-[10px] text-[#6a6a6a]
                                 bg-[#252525] border border-[#333] hover:bg-[#2a2a2a] hover:text-[#aaa]
                                 opacity-0 group-hover:opacity-100 transition-opacity mt-0.5"
                    >
                      <Send size={10} /> Send to AI
                    </button>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
};
