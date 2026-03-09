import type Database from 'better-sqlite3';

/**
 * Run after large deletions (purgeFile, full re-index).
 * Don't run on every indexing op — only when meaningful data was deleted.
 */
export function runMaintenance(db: Database.Database): void {
  db.pragma('analysis_limit = 1000');
  db.exec('ANALYZE');
  // VACUUM reclaims space after deletions — run via WAL checkpoint
  db.pragma('wal_checkpoint(TRUNCATE)');
}
