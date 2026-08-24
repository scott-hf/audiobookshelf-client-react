import Database from 'better-sqlite3'

// Kept in sync with ./migrations/001_initial.sql (source of truth for readability/tooling).
// Embedded here as a string so the compiled `dist/` output does not need to copy non-JS
// assets -- the migration runs identically whether executing from src via a dev runner
// or from the built service.
const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE search_sessions (
  id TEXT PRIMARY KEY, abs_user_id TEXT NOT NULL, abs_library_id TEXT NOT NULL,
  query TEXT NOT NULL, results_json TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE acquisitions (
  id TEXT PRIMARY KEY, abs_user_id TEXT NOT NULL, abs_library_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL, search_session_id TEXT NOT NULL, release_id TEXT NOT NULL,
  librarr_job_id TEXT, title TEXT NOT NULL, author TEXT NOT NULL, narrators_json TEXT NOT NULL DEFAULT '[]',
  format TEXT, size_bytes INTEGER, source_label TEXT, state TEXT NOT NULL, progress_percent REAL,
  staging_path TEXT, final_path TEXT, abs_item_id TEXT, error_code TEXT, error_message TEXT,
  error_retryable INTEGER NOT NULL DEFAULT 0, last_successful_stage TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT,
  UNIQUE(abs_user_id, idempotency_key),
  FOREIGN KEY(search_session_id) REFERENCES search_sessions(id)
);
CREATE INDEX acquisitions_user_library_updated ON acquisitions(abs_user_id, abs_library_id, updated_at DESC);
`.trim()
  }
]

export function openDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  applyMigrations(db)
  return db
}

function applyMigrations(db: Database.Database): void {
  const hasMigrationsTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get()

  const appliedVersions = new Set<number>(
    hasMigrationsTable
      ? (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((row) => row.version)
      : []
  )

  const pending = MIGRATIONS.filter((migration) => !appliedVersions.has(migration.version)).sort(
    (a, b) => a.version - b.version
  )
  if (pending.length === 0) return

  const applyAll = db.transaction(() => {
    for (const migration of pending) {
      db.exec(migration.sql)
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        migration.version,
        new Date().toISOString()
      )
    }
  })
  applyAll()
}
