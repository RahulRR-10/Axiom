import { ipcMain } from 'electron';

import { SEARCH_CHANNELS } from '../../shared/ipc/channels';
import type { SearchQueryResponse } from '../../shared/ipc/contracts';
import type { SearchResult } from '../../shared/types';
import { getDb } from '../database/schema';
import { embed } from '../workers/embedder';
import { searchVectors } from '../database/vectorStore';

// ── Registry ──────────────────────────────────────────────────────────────────

export function registerSearchHandlers(): void {
  ipcMain.handle(
    SEARCH_CHANNELS.QUERY,
    (_e, query: string, vaultPath: string, subject?: string, fileType?: string) =>
      handleSearch(query, vaultPath, subject, fileType),
  );
}

// ── Unified search handler ────────────────────────────────────────────────────

async function handleSearch(
  query: string,
  vaultPath: string,
  subject?: string,
  fileType?: string,
): Promise<SearchQueryResponse> {
  if (!query.trim()) return [];

  const db = getDb(vaultPath);
  const resultMap = new Map<string, SearchResult>();
  const t0 = Date.now();

  const subjectFilter = subject ? 'AND f.subject = ?' : '';
  const typeFilter = fileType ? 'AND f.type = ?' : '';

  // ── 1. FTS5 keyword pass ────────────────────────────────────────────────
  try {
    const params: unknown[] = [query];
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

    console.log(`[search] FTS5: ${rows.length} results in ${Date.now() - t0}ms`);

    const maxBm25 = Math.max(...rows.map((r) => r.bm25), 1);

    for (const r of rows) {
      const bm25Score = r.bm25 / maxBm25;
      let score = 0.4 * bm25Score;
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
  } catch (err) {
    console.warn('[search] FTS5 error:', err);
  }

  // ── 2. Semantic pass ────────────────────────────────────────────────────
  const t1 = Date.now();
  try {
    const queryVec = await embed(query);
    const semRows = await searchVectors(vaultPath, queryVec, 30);
    console.log(`[search] semantic: ${semRows.length} results in ${Date.now() - t1}ms`);

    for (const r of semRows) {
      const existing = resultMap.get(r.id);
      const semScore = 0.6 * r.score;

      if (existing) {
        existing.score += semScore;
      } else {
        const meta = db.prepare(`
          SELECT c.text, c.is_annotation, c.page_or_slide,
                 f.name AS file_name, f.path AS file_path, f.type AS file_type, f.subject
          FROM chunks c JOIN files f ON f.id = c.file_id
          WHERE c.id = ?
        `).get(r.id) as {
          text: string; is_annotation: number; page_or_slide: number | null;
          file_name: string; file_path: string; file_type: string; subject: string | null;
        } | undefined;

        if (meta) {
          if (subject && meta.subject !== subject) continue;
          if (fileType && meta.file_type !== fileType) continue;

          let score = semScore;
          if (meta.is_annotation) score *= 1.3;
          resultMap.set(r.id, {
            id: r.id,
            file_id: r.file_id,
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
    }
  } catch (err) {
    console.warn('[search] Semantic error (FTS5-only):', err);
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

    for (const r of fileRows) {
      const hasChunk = Array.from(resultMap.values()).some((v) => v.file_id === r.id);
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

  console.log(`[search] Total: ${resultMap.size} results in ${Date.now() - t0}ms`);

  return Array.from(resultMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 30);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function categorize(r: {
  is_annotation: number;
  page_or_slide: number | null;
  file_type?: string;
}): SearchResult['category'] {
  if (r.is_annotation) return 'annotation';
  if (r.page_or_slide != null) return 'page';
  return 'file';
}
