import { ipcMain } from 'electron';

import { SEARCH_CHANNELS } from '../../shared/ipc/channels';
import type { SearchFullResponse, SearchSpotlightResponse } from '../../shared/ipc/contracts';
import type { SpotlightResult } from '../../shared/types';
import { getDb } from '../database/schema';
import { embed } from '../workers/embedder';
import { searchVectors } from '../database/vectorStore';

// ── Registry ──────────────────────────────────────────────────────────────────

export function registerSearchHandlers(): void {
  ipcMain.handle(SEARCH_CHANNELS.SPOTLIGHT, (_e, query: string, vaultPath: string) =>
    handleSpotlight(query, vaultPath),
  );
  ipcMain.handle(SEARCH_CHANNELS.FULL, (_e, query: string, vaultPath: string, subject?: string, fileType?: string) =>
    handleFullSearch(query, vaultPath, subject, fileType),
  );
}

// ── Handler implementations ───────────────────────────────────────────────────

function handleSpotlight(query: string, vaultPath: string): SearchSpotlightResponse {
  if (!query.trim()) return [];

  const db = getDb(vaultPath);
  const results: SpotlightResult[] = [];
  const seen = new Set<string>();

  // FTS5 keyword search over chunks
  try {
    const t0 = Date.now();
    const rows = db.prepare(`
      SELECT c.id, c.file_id, c.page_or_slide, c.text,
             f.name AS file_name, f.type AS file_type, f.subject
      FROM   chunks_fts fts
      JOIN   chunks c ON c.rowid = fts.rowid
      JOIN   files  f ON f.id = c.file_id
      WHERE  chunks_fts MATCH ?
      ORDER  BY rank
      LIMIT  8
    `).all(query) as Array<{
      id: string; file_id: string; page_or_slide: number | null;
      text: string; file_name: string; file_type: string; subject: string | null;
    }>;

    console.log(`[search:spotlight] FTS5: ${rows.length} results in ${Date.now() - t0}ms`);

    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      results.push({
        id:           r.id,
        file_id:      r.file_id,
        file_name:    r.file_name,
        file_type:    r.file_type,
        subject:      r.subject,
        page_or_slide: r.page_or_slide,
        snippet:      r.text.slice(0, 120),
        type:         'chunk',
      });
    }
  } catch (err) {
    console.warn('[search:spotlight] FTS5 error:', err);
  }

  // Also search notes title / content
  try {
    const noteRows = db.prepare(`
      SELECT id, title, subject, content
      FROM   notes
      WHERE  title LIKE ? OR content LIKE ?
      LIMIT  4
    `).all(`%${query}%`, `%${query}%`) as Array<{
      id: string; title: string; subject: string | null; content: string;
    }>;

    for (const r of noteRows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      results.push({
        id:           r.id,
        file_id:      null,
        file_name:    r.title,
        file_type:    'md',
        subject:      r.subject,
        page_or_slide: null,
        snippet:      r.content.slice(0, 120),
        type:         'note',
      });
    }
  } catch (err) {
    console.warn('[search:spotlight] Notes search error:', err);
  }

  return results.slice(0, 8);
}

async function handleFullSearch(
  query: string,
  vaultPath: string,
  subject?: string,
  fileType?: string,
): Promise<SearchFullResponse> {
  if (!query.trim()) return [];

  const db = getDb(vaultPath);
  const resultMap = new Map<string, SearchFullResponse[number]>();
  const t0 = Date.now();

  // ── FTS5 keyword pass ─────────────────────────────────────────────────────
  try {
    const subjectFilter = subject ? 'AND f.subject = ?' : '';
    const typeFilter    = fileType ? 'AND f.type = ?' : '';
    const params: unknown[] = [query];
    if (subject)  params.push(subject);
    if (fileType) params.push(fileType);

    const rows = db.prepare(`
      SELECT c.id, c.file_id, c.page_or_slide, c.text, c.is_annotation,
             f.name AS file_name, f.type AS file_type, f.subject,
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
      is_annotation: number; file_name: string; file_type: string;
      subject: string | null; bm25: number;
    }>;

    console.log(`[search:full] FTS5: ${rows.length} results in ${Date.now() - t0}ms`);

    // Normalise BM25 to [0,1]
    const maxBm25 = Math.max(...rows.map((r) => r.bm25), 1);

    for (const r of rows) {
      const bm25Score = r.bm25 / maxBm25;
      let score = 0.4 * bm25Score;
      if (r.is_annotation) score *= 1.3;
      resultMap.set(r.id, {
        id:           r.id,
        file_id:      r.file_id,
        file_name:    r.file_name,
        file_type:    r.file_type,
        subject:      r.subject,
        page_or_slide: r.page_or_slide,
        text:         r.text,
        score,
        is_annotation: r.is_annotation,
        source:       'fts',
      });
    }
  } catch (err) {
    console.warn('[search:full] FTS5 error:', err);
  }

  const t1 = Date.now();

  // ── Semantic pass ─────────────────────────────────────────────────────────
  try {
    const queryVec = await embed(query);
    const semRows  = await searchVectors(vaultPath, queryVec, 30);
    console.log(`[search:full] semantic: ${semRows.length} results in ${Date.now() - t1}ms`);

    for (const r of semRows) {
      const existing = resultMap.get(r.id);
      const semScore = 0.6 * r.score;

      if (existing) {
        existing.score += semScore;
        existing.source = 'fts'; // hybrid
      } else {
        // Fetch metadata for semantic-only hits
        const meta = db.prepare(`
          SELECT c.text, c.is_annotation, c.page_or_slide,
                 f.name AS file_name, f.type AS file_type, f.subject
          FROM chunks c JOIN files f ON f.id = c.file_id
          WHERE c.id = ?
        `).get(r.id) as { text: string; is_annotation: number; page_or_slide: number | null; file_name: string; file_type: string; subject: string | null } | undefined;

        if (meta) {
          let score = semScore;
          if (meta.is_annotation) score *= 1.3;
          resultMap.set(r.id, {
            id:           r.id,
            file_id:      r.file_id,
            file_name:    meta.file_name,
            file_type:    meta.file_type,
            subject:      meta.subject,
            page_or_slide: meta.page_or_slide,
            text:         meta.text,
            score,
            is_annotation: meta.is_annotation,
            source:       'semantic',
          });
        }
      }
    }
  } catch (err) {
    console.warn('[search:full] Semantic search error (falling back to FTS5-only):', err);
  }

  console.log(`[search:full] Total: ${resultMap.size} merged results in ${Date.now() - t0}ms`);

  return Array.from(resultMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
}
