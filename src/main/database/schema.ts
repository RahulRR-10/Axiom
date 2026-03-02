import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

import { MIGRATIONS } from './migrations';

// ── Singleton cache keyed by vault path ──────────────────────────────────────
const dbCache = new Map<string, Database.Database>();

/**
 * Return (or create) the better-sqlite3 Database for `vaultPath`.
 * On first call the `.axiom` directory is created, migrations are run, and
 * the connection is cached so subsequent calls are instant.
 */
export function getDb(vaultPath: string): Database.Database {
  const existing = dbCache.get(vaultPath);
  if (existing) return existing;

  const axiomDir = path.join(vaultPath, '.axiom');
  fs.mkdirSync(axiomDir, { recursive: true });

  const dbPath = path.join(axiomDir, 'axiom.db');
  const db = new Database(dbPath);

  // Performance settings
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  runMigrations(db);
  dbCache.set(vaultPath, db);
  return db;
}

/**
 * Close and evict the cached DB for `vaultPath` (e.g. when a new vault is
 * opened).
 */
export function closeDb(vaultPath: string): void {
  const db = dbCache.get(vaultPath);
  if (db) {
    db.close();
    dbCache.delete(vaultPath);
  }
}

// ── Migration runner ─────────────────────────────────────────────────────────

function runMigrations(db: Database.Database): void {
  // Bootstrap the migrations tracking table itself
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);

  const applied = new Set<string>(
    (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: string }>)
      .map((r) => r.version),
  );

  const applyMigration = db.transaction((version: string, sql: string) => {
    db.exec(sql);
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
      version,
      Date.now(),
    );
  });

  for (const migration of MIGRATIONS) {
    if (!applied.has(migration.version)) {
      console.log(`[schema] Applying migration ${migration.version}`);
      applyMigration(migration.version, migration.sql);
    }
  }
}
