// Migrations are embedded as TypeScript constants to work correctly in the
// packaged Electron app (no filesystem path assumptions needed).

export const MIGRATIONS: Array<{ version: string; sql: string }> = [
  {
    version: '001_init',
    sql: `
      CREATE TABLE IF NOT EXISTS files (
        id           TEXT PRIMARY KEY,
        path         TEXT UNIQUE NOT NULL,
        name         TEXT NOT NULL,
        type         TEXT NOT NULL,
        subject      TEXT,
        size         INTEGER,
        mtime_ms     INTEGER,
        content_hash TEXT,
        indexed_at   INTEGER,
        created_at   INTEGER DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS chunks (
        id            TEXT PRIMARY KEY,
        file_id       TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        page_or_slide INTEGER,
        text          TEXT NOT NULL,
        chunk_index   INTEGER,
        is_annotation INTEGER DEFAULT 0,
        FOREIGN KEY(file_id) REFERENCES files(id)
      );

      CREATE TABLE IF NOT EXISTS notes (
        id             TEXT PRIMARY KEY,
        title          TEXT NOT NULL,
        content        TEXT DEFAULT '',
        subject        TEXT,
        source_file_id TEXT,
        source_page    INTEGER,
        created_at     INTEGER DEFAULT (unixepoch()),
        updated_at     INTEGER DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS tags (
        id   TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL
      );

      CREATE TABLE IF NOT EXISTS file_tags (
        file_id TEXT REFERENCES files(id) ON DELETE CASCADE,
        tag_id  TEXT REFERENCES tags(id) ON DELETE CASCADE,
        PRIMARY KEY (file_id, tag_id)
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts
        USING fts5(text, file_id, page_or_slide, content=chunks, content_rowid=rowid);

      CREATE INDEX IF NOT EXISTS idx_chunks_file_id ON chunks(file_id);
      CREATE INDEX IF NOT EXISTS idx_files_subject  ON files(subject);
      CREATE INDEX IF NOT EXISTS idx_notes_subject  ON notes(subject);
    `,
  },
  {
    version: '002_annotations',
    sql: `
      CREATE TABLE IF NOT EXISTS annotations (
        id         TEXT PRIMARY KEY,
        file_id    TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        page       INTEGER NOT NULL,
        type       TEXT NOT NULL,
        data_json  TEXT NOT NULL,
        created_at INTEGER DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_annotations_file_id ON annotations(file_id);
    `,
  },
  {
    version: '003_annotations_drop_fk',
    sql: `
      -- SQLite cannot ALTER TABLE to drop a constraint, so we recreate the
      -- table without the FOREIGN KEY on file_id.  This allows annotations
      -- to be saved for PDFs that haven't been indexed yet.
      CREATE TABLE IF NOT EXISTS annotations_new (
        id         TEXT PRIMARY KEY,
        file_id    TEXT NOT NULL,
        page       INTEGER NOT NULL,
        type       TEXT NOT NULL,
        data_json  TEXT NOT NULL,
        created_at INTEGER DEFAULT (unixepoch())
      );

      INSERT OR IGNORE INTO annotations_new
        SELECT id, file_id, page, type, data_json, created_at
        FROM annotations;

      DROP TABLE IF EXISTS annotations;
      ALTER TABLE annotations_new RENAME TO annotations;

      CREATE INDEX IF NOT EXISTS idx_annotations_file_id ON annotations(file_id);
    `,
  },
  {
    version: '004_notes_file_path',
    sql: `
      ALTER TABLE notes ADD COLUMN file_path TEXT;
      CREATE INDEX IF NOT EXISTS idx_notes_file_path ON notes(file_path);
    `,
  },
  {
    version: '005_chunks_fix_duplicate_fk',
    sql: `
      -- Recreate chunks without the duplicate (non-cascading) table-level FK.
      CREATE TABLE IF NOT EXISTS chunks_new (
        id            TEXT PRIMARY KEY,
        file_id       TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        page_or_slide INTEGER,
        text          TEXT NOT NULL,
        chunk_index   INTEGER,
        is_annotation INTEGER DEFAULT 0
      );

      INSERT OR IGNORE INTO chunks_new
        SELECT id, file_id, page_or_slide, text, chunk_index, is_annotation
        FROM chunks;

      DROP TABLE IF EXISTS chunks;
      ALTER TABLE chunks_new RENAME TO chunks;

      CREATE INDEX IF NOT EXISTS idx_chunks_file_id ON chunks(file_id);

      -- Rebuild the FTS5 content table reference
      DROP TABLE IF EXISTS chunks_fts;
      CREATE VIRTUAL TABLE chunks_fts
        USING fts5(text, file_id, page_or_slide, content=chunks, content_rowid=rowid);
      INSERT INTO chunks_fts(rowid, text, file_id, page_or_slide)
        SELECT rowid, text, file_id, page_or_slide FROM chunks;
    `,
  },
  {
    version: '006_settings',
    sql: `
      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT
      );
    `,
  },
];
