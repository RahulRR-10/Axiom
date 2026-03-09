import crypto from 'crypto';

import type Database from 'better-sqlite3';

// Session-level in-memory cache — survives hot reindexing within one session
const SESSION_CACHE = new Map<string, number[]>();
const CURRENT_MODEL = 'bge-small-en-v1.5';

export function sha256(input: Buffer | string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function queryEmbedCache(db: Database.Database, textHash: string): number[] | null {
  // Check in-memory first (fastest)
  if (SESSION_CACHE.has(textHash)) return SESSION_CACHE.get(textHash)!;

  // Fall back to DB
  const row = db.prepare(
    'SELECT vector FROM embed_cache WHERE text_hash=? AND model=?'
  ).get(textHash, CURRENT_MODEL) as { vector: string } | undefined;

  if (!row) return null;

  const vec = JSON.parse(row.vector) as number[];
  SESSION_CACHE.set(textHash, vec); // promote to in-memory
  return vec;
}

export function saveEmbedCacheMemory(textHash: string, vector: number[]): void {
  SESSION_CACHE.set(textHash, vector);
}

/**
 * Call this on app startup — re-populate in-memory cache from DB.
 * Only loads embeddings from the current model to avoid stale data.
 */
export function warmEmbedCache(db: Database.Database): void {
  const rows = db.prepare(
    'SELECT text_hash, vector FROM embed_cache WHERE model=? LIMIT 50000'
  ).all(CURRENT_MODEL) as { text_hash: string; vector: string }[];

  for (const row of rows) {
    SESSION_CACHE.set(row.text_hash, JSON.parse(row.vector));
  }
}
