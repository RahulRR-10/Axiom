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
];
