import * as fs from 'fs';
import * as path from 'path';

import type { ChunkWithVector, SearchResult } from '../../shared/types';

// vectordb v0.21 ships CommonJS + type definitions
// eslint-disable-next-line @typescript-eslint/no-require-imports
const lancedb = require('vectordb') as typeof import('vectordb');

type LanceTable = Awaited<ReturnType<Awaited<ReturnType<typeof lancedb.connect>>['openTable']>>;

const VECTOR_DIM = 768;
const TABLE_NAME = 'chunk_vectors';

// ── Connection cache ─────────────────────────────────────────────────────────
let _connection: Awaited<ReturnType<typeof lancedb.connect>> | null = null;
let _table: LanceTable | null = null;
let _vaultPath = '';

async function getTable(vaultPath: string): Promise<LanceTable> {
  const vectorsDir = path.join(vaultPath, '.axiom', 'vectors');

  // Reconnect when vault changes
  if (vaultPath !== _vaultPath || !_connection) {
    fs.mkdirSync(vectorsDir, { recursive: true });
    _connection = await lancedb.connect(vectorsDir);
    _vaultPath = vaultPath;
    _table = null;
  }

  // Return cached table handle
  if (_table) return _table;

  const tableNames: string[] = await _connection!.tableNames();

  if (tableNames.includes(TABLE_NAME)) {
    _table = await _connection!.openTable(TABLE_NAME);
  } else {
    // Bootstrap: create table with a sentinel row then delete it
    const sentinel = makeRow('_init', '_init', null, '', new Array(VECTOR_DIM).fill(0));
    _table = await _connection!.createTable(TABLE_NAME, [sentinel]);
    await (_table as unknown as { delete: (f: string) => Promise<void> }).delete("id = '_init'");
  }

  return _table!;
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function addVectors(vaultPath: string, chunks: ChunkWithVector[]): Promise<void> {
  if (chunks.length === 0) return;
  const table = await getTable(vaultPath);
  const rows = chunks.map((c) =>
    makeRow(c.id, c.file_id, c.page_or_slide ?? null, c.text, c.vector),
  );
  await (table as unknown as { add: (rows: unknown[]) => Promise<unknown> }).add(rows);
}

export async function searchVectors(
  vaultPath: string,
  queryVector: number[],
  limit = 20,
): Promise<Array<{ id: string; file_id: string; page_or_slide: number | null; text: string; score: number }>> {
  try {
    const table = await getTable(vaultPath);
    const results = await (
      table as unknown as {
        search: (v: number[]) => {
          metricType: (d: string) => { limit: (n: number) => { execute: () => Promise<unknown[]> } };
          limit: (n: number) => { execute: () => Promise<unknown[]> };
        };
      }
    )
      .search(queryVector)
      .metricType('cosine')
      .limit(limit)
      .execute();

    return (results as Array<Record<string, unknown>>).map((r) => ({
      id:            r['id'] as string,
      file_id:       r['file_id'] as string,
      page_or_slide: r['page_or_slide'] as number | null,
      text:          r['text'] as string,
      score:         1 - (r['_distance'] as number ?? 0), // cosine: 1-distance = similarity
    }));
  } catch {
    return [];
  }
}

export async function deleteVectorsByFileId(vaultPath: string, fileId: string): Promise<void> {
  try {
    const table = await getTable(vaultPath);
    await (table as unknown as { delete: (f: string) => Promise<void> }).delete(
      `file_id = '${fileId.replace(/'/g, "''")}'`,
    );
  } catch {
    // Non-fatal: table may be empty
  }
}

export function invalidateVectorCache(): void {
  _connection = null;
  _table = null;
  _vaultPath = '';
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRow(
  id: string,
  file_id: string,
  page_or_slide: number | null,
  text: string,
  vector: number[],
) {
  return { id, file_id, page_or_slide: page_or_slide ?? 0, text, vector };
}
