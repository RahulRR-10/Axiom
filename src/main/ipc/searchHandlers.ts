import { ipcMain } from 'electron';

import { SEARCH_CHANNELS } from '../../shared/ipc/channels';
import type { SearchQueryResponse } from '../../shared/ipc/contracts';
import type { SearchResult } from '../../shared/types';
import { getDb } from '../database/schema';
import { embedQuery } from '../workers/embedderManager';
import { QUERY_PREFIX } from '../workers/embedder';
import { searchVectors } from '../database/vectorStore';
import { writeLog } from '../logger';

// ── Registry ──────────────────────────────────────────────────────────────────

export function registerSearchHandlers(): void {
  ipcMain.handle(
    SEARCH_CHANNELS.QUERY,
    async (_e, query: string, vaultPath: string, subject?: string, fileType?: string) => {
      try {
        return await runSearch(query, vaultPath, subject, fileType);
      } catch (err) {
        try { writeLog('search:ERROR', err); } catch { /* ignore */ }
        throw err;
      }
    },
  );
}

// ── In-flight guard — prevents parallel embed calls from rapid keystrokes ─────
let searchInFlight: Promise<SearchQueryResponse> | null = null;

// ── Unified search handler ────────────────────────────────────────────────────

async function runSearch(
  query: string,
  vaultPath: string,
  subject?: string,
  fileType?: string,
): Promise<SearchQueryResponse> {
  if (!query.trim()) return [];

  // Wait for any running search to complete before starting a new one
  if (searchInFlight) {
    await searchInFlight.catch(() => {});
  }

  searchInFlight = handleSearch(query, vaultPath, subject, fileType)
    .finally(() => { searchInFlight = null; });

  return searchInFlight;
}

async function handleSearch(
  query: string,
  vaultPath: string,
  subject?: string,
  fileType?: string,
): Promise<SearchQueryResponse> {
  if (!query.trim()) return [];

  try { writeLog('search:query', query, true); } catch { /* ignore */ }
  const db = getDb(vaultPath);
  const resultMap = new Map<string, SearchResult>();

  // ── Intent-based weight tuning ──────────────────────────────────────────
  const intent = classifyQueryIntent(query);
  const ftsWeight = intent === 'keyword' ? 0.6 : 0.25;
  const semWeight = intent === 'keyword' ? 0.4 : 0.75;
  const COSINE_THRESHOLD = 0.3;

  const subjectFilter = subject ? 'AND f.subject = ?' : '';
  const typeFilter = fileType ? 'AND f.type = ?' : '';

  // ── Start semantic embedding in background (parallel with FTS5) ────────
  const expandedQuery = expandQuery(query);
  try { writeLog('search:expand', expandedQuery, true); } catch { /* ignore */ }
  type SemRow = { id: string; file_id: string; page_or_slide: number | null; text: string; score: number };
  const tEmbed = Date.now();
  const EMBED_TIMEOUT_MS = 6_000; // fall back to FTS-only if embedder is saturated
  let embedTimeoutId: ReturnType<typeof setTimeout>;
  const semanticPromise: Promise<SemRow[]> = Promise.race([
    embedQuery([QUERY_PREFIX + expandedQuery])
      .then(([vec]) => {
        clearTimeout(embedTimeoutId);
        try { writeLog('search:embed', `${Date.now() - tEmbed}ms`, true); } catch { /* ignore */ }
        return searchVectors(vaultPath, vec, 30);
      })
      .then((rows) => {
        if (rows.length > 0) {
          try { writeLog('search:vector', `${rows.length} results top:${rows[0].score.toFixed(3)}`, true); } catch { /* ignore */ }
          console.log(`[search] Semantic: ${rows.length} raw results, top score=${rows[0].score.toFixed(3)}, bottom=${rows[rows.length - 1].score.toFixed(3)}`);
        } else {
          try { writeLog('search:vector', '0 results', true); } catch { /* ignore */ }
          console.log('[search] Semantic: 0 raw results from vector search');
        }
        return rows.filter((r) => r.score >= COSINE_THRESHOLD);
      })
      .catch((err) => {
        clearTimeout(embedTimeoutId);
        try { writeLog('search:ERROR', err); } catch { /* ignore */ }
        console.warn('[search] Semantic error:', err);
        return [] as SemRow[];
      }),
    new Promise<SemRow[]>((resolve) => {
      embedTimeoutId = setTimeout(() => {
        try { writeLog('search:embed', `timeout after ${EMBED_TIMEOUT_MS}ms — skipping semantic`, true); } catch { /* ignore */ }
        console.warn('[search] Semantic embed timed out — returning FTS results only');
        resolve([]);
      }, EMBED_TIMEOUT_MS);
    }),
  ]);

  // ── 1. FTS5 keyword pass (sync — runs while embedding computes) ────────
  try {
    const ftsQuery = sanitizeFtsQuery(query);
    if (!ftsQuery) throw new Error('empty FTS query after sanitization');
    const params: unknown[] = [ftsQuery];
    if (subject) params.push(subject);
    if (fileType) params.push(fileType);

    const rows = db.prepare(`
      SELECT c.id, c.file_id, c.page_or_slide, c.text, c.is_annotation,
             f.name AS file_name, f.path AS file_path, f.type AS file_type, f.subject,
             -fts.rank AS bm25
      FROM   chunks_fts fts
      JOIN   chunks c ON c.rowid = fts.rowid
      JOIN   files  f ON f.id = c.file_id
      WHERE  chunks_fts MATCH ?
             ${subjectFilter} ${typeFilter}
      ORDER  BY rank
      LIMIT  50
    `).all(...params) as Array<{
      id: string; file_id: string; page_or_slide: number | null; text: string;
      is_annotation: number; file_name: string; file_path: string; file_type: string;
      subject: string | null; bm25: number;
    }>;

    const maxBm25 = Math.max(...rows.map((r) => r.bm25), 1);

    for (const r of rows) {
      const bm25Score = r.bm25 / maxBm25;
      let score = ftsWeight * bm25Score;
      if (r.is_annotation) score *= 1.3;
      resultMap.set(r.id, {
        id: r.id,
        file_id: r.file_id,
        file_name: r.file_name,
        file_path: r.file_path,
        file_type: r.file_type,
        subject: r.subject,
        page_or_slide: r.page_or_slide,
        text: r.text,
        score,
        is_annotation: r.is_annotation,
        category: categorize(r),
        source: 'fts',
      });
    }
    try { writeLog('search:fts', `${rows.length} results`, true); } catch { /* ignore */ }
  } catch (err) {
    try { writeLog('search:ERROR', err); } catch { /* ignore */ }
    console.warn('[search] FTS5 error:', err);
  }

  // ── 2. Await semantic results and merge ─────────────────────────────────
  try {
    const semRows = await semanticPromise;

    // Collect IDs of semantic results not already in resultMap for a batch query
    const uncachedIds: string[] = [];
    const semScores = new Map<string, number>();
    for (const r of semRows) {
      const semScore = semWeight * r.score;
      const existing = resultMap.get(r.id);
      if (existing) {
        existing.score += semScore;
      } else {
        uncachedIds.push(r.id);
        semScores.set(r.id, semScore);
      }
    }

    // Batch lookup: single query instead of N individual queries
    if (uncachedIds.length > 0) {
      const placeholders = uncachedIds.map(() => '?').join(',');
      const metaRows = db.prepare(`
        SELECT c.id, c.text, c.is_annotation, c.page_or_slide, c.file_id,
               f.name AS file_name, f.path AS file_path, f.type AS file_type, f.subject
        FROM chunks c JOIN files f ON f.id = c.file_id
        WHERE c.id IN (${placeholders})
      `).all(...uncachedIds) as Array<{
        id: string; text: string; is_annotation: number; page_or_slide: number | null;
        file_id: string; file_name: string; file_path: string; file_type: string; subject: string | null;
      }>;

      for (const meta of metaRows) {
        if (subject && meta.subject !== subject) continue;
        if (fileType && meta.file_type !== fileType) continue;

        let score = semScores.get(meta.id) ?? 0;
        if (meta.is_annotation) score *= 1.3;
        resultMap.set(meta.id, {
          id: meta.id,
          file_id: meta.file_id,
          file_name: meta.file_name,
          file_path: meta.file_path,
          file_type: meta.file_type,
          subject: meta.subject,
          page_or_slide: meta.page_or_slide,
          text: meta.text,
          score,
          is_annotation: meta.is_annotation,
          category: categorize(meta),
          source: 'semantic',
        });
      }
    }
  } catch (err) {
    console.warn('[search] Semantic merge error:', err);
  }

  // ── 3. Notes search ────────────────────────────────────────────────────
  if (!fileType || fileType === 'md') {
    try {
      const noteSubjectFilter = subject ? 'AND subject = ?' : '';
      const noteParams: unknown[] = [`%${query}%`, `%${query}%`];
      if (subject) noteParams.push(subject);

      const noteRows = db.prepare(`
        SELECT id, title, file_path, subject, content
        FROM   notes
        WHERE  (title LIKE ? OR content LIKE ?)
               ${noteSubjectFilter}
        LIMIT  8
      `).all(...noteParams) as Array<{
        id: string; title: string; file_path: string; subject: string | null; content: string;
      }>;

      for (const r of noteRows) {
        if (resultMap.has(r.id)) continue;
        resultMap.set(r.id, {
          id: r.id,
          file_id: r.id,
          file_name: r.title,
          file_path: r.file_path ?? '',
          file_type: 'md',
          subject: r.subject,
          page_or_slide: null,
          text: r.content.slice(0, 250),
          score: 0.25,
          is_annotation: 0,
          category: 'note',
          source: 'note',
        });
      }
    } catch (err) {
      console.warn('[search] Notes error:', err);
    }
  }

  // ── 4. File-name fallback ──────────────────────────────────────────────
  try {
    const fnSubjectFilter = subject ? 'AND subject = ?' : '';
    const fnTypeFilter = fileType ? 'AND type = ?' : '';
    const fnParams: unknown[] = [`%${query}%`];
    if (subject) fnParams.push(subject);
    if (fileType) fnParams.push(fileType);

    const fileRows = db.prepare(`
      SELECT id, name, path, type, subject
      FROM   files
      WHERE  name LIKE ?
             ${fnSubjectFilter} ${fnTypeFilter}
      LIMIT  10
    `).all(...fnParams) as Array<{
      id: string; name: string; path: string; type: string; subject: string | null;
    }>;

    // Build a Set of file_ids already represented in results for O(1) lookup
    const coveredFileIds = new Set<string>();
    for (const v of resultMap.values()) coveredFileIds.add(v.file_id);

    for (const r of fileRows) {
      const hasChunk = coveredFileIds.has(r.id);
      if (!hasChunk) {
        const key = `fname:${r.id}`;
        if (!resultMap.has(key)) {
          resultMap.set(key, {
            id: r.id,
            file_id: r.id,
            file_name: r.name,
            file_path: r.path,
            file_type: r.type,
            subject: r.subject,
            page_or_slide: null,
            text: r.name,
            score: 0.05,
            is_annotation: 0,
            category: 'file',
            source: 'fts',
          });
        }
      }
    }
  } catch (err) {
    console.warn('[search] File-name fallback error:', err);
  }

  const finalResults = Array.from(resultMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 30);
  try { writeLog('search:result', `${finalResults.length} merged results`, true); } catch { /* ignore */ }
  return finalResults;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

type QueryIntent = 'keyword' | 'conceptual';

/** Classify whether the query is a keyword lookup or a conceptual question. */
function classifyQueryIntent(query: string): QueryIntent {
  const trimmed = query.trim();
  const words = trimmed.split(/\s+/);
  const isQuestion =
    /^(what|how|why|when|where|who|which|explain|describe|compare|define)\b/i.test(trimmed) ||
    trimmed.endsWith('?');
  if (isQuestion) return 'conceptual';
  if (words.length >= 5) return 'conceptual';
  return 'keyword';
}

/**
 * Rewrite the query into a richer sentence for better embedding.
 * The raw keywords still go to FTS5; this expanded form is only used for
 * the vector-similarity branch so the embedding captures related concepts.
 */
function expandQuery(query: string): string {
  const trimmed = query.trim().replace(/\?+$/, '');

  const patterns: Array<[RegExp, string]> = [
    [/^what\s+(?:is|are)\s+(.+)/i,                    '$1 — definition, meaning, concept, explanation, overview'],
    [/^how\s+(?:does|do|can|could|should|to)\s+(.+)/i, '$1 — process, method, mechanism, steps, technique, procedure'],
    [/^why\s+(?:does|do|is|are|did)\s+(.+)/i,          '$1 — reason, cause, explanation, because, purpose'],
    [/^explain\s+(.+)/i,                                '$1 — explanation, concept, overview, description, meaning'],
    [/^describe\s+(.+)/i,                               '$1 — description, characteristics, properties, features, overview'],
    [/^compare\s+(.+)/i,                                '$1 — comparison, differences, similarities, versus, contrast'],
    [/^define\s+(.+)/i,                                 '$1 — definition, meaning, terminology, concept'],
    [/^when\s+(?:does|do|did|is|was)\s+(.+)/i,          '$1 — timing, date, period, occurrence, event'],
    [/^where\s+(?:does|do|did|is|was)\s+(.+)/i,         '$1 — location, place, position, context, setting'],
    [/^who\s+(?:is|are|was|were)\s+(.+)/i,              '$1 — person, identity, role, biography, background'],
  ];

  for (const [pattern, replacement] of patterns) {
    if (pattern.test(trimmed)) return trimmed.replace(pattern, replacement);
  }

  // Generic expansion: add related-concept hints for the embedding model
  return `${trimmed} — related concepts, explanation, context, overview`;
}

/**
 * Sanitize a user query for SQLite FTS5 MATCH syntax.
 * Strips operators (-/NOT/OR/AND/NEAR), quotes each token so hyphens and
 * special chars inside words are treated as literals, not operators.
 * Uses OR so chunks matching ANY keyword appear; BM25 ranks multi-matches higher.
 */
function sanitizeFtsQuery(query: string): string {
  const tokens = query
    .replace(/["():^*{}~\\]/g, ' ')   // strip FTS5 syntax chars
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !/^(AND|OR|NOT|NEAR)$/i.test(t));
  if (tokens.length === 0) return '';
  // Quote each token so hyphens etc. are literal; OR for broader recall
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

function categorize(r: {
  is_annotation: number;
  page_or_slide: number | null;
  file_type?: string;
}): SearchResult['category'] {
  if (r.is_annotation) return 'annotation';
  if (r.page_or_slide != null) return 'page';
  return 'file';
}
