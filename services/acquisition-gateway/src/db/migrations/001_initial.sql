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

-- Migration 2 (WI-1496 t300): librarr_job_id is repurposed as a generic, prefixed tracking
-- key ("torrent:<hash>" | "job:<id>" | "nzb:<id>") per the submit-response hash > job_id >
-- nzo_id > search-result info_hash precedence -- never title matching (correction #3).
-- stalled_since backs the reconciler's TorBox download_uncached stall policy (FND-00410):
-- no progress past 0 bytes for STALL_TIMEOUT_SECONDS moves the row to failed/retryable.
ALTER TABLE acquisitions RENAME COLUMN librarr_job_id TO tracking_key;
ALTER TABLE acquisitions ADD COLUMN stalled_since TEXT;
