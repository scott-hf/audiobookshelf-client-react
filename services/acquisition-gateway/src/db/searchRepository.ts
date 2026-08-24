import type Database from 'better-sqlite3'

export interface SearchSessionRecord {
  id: string
  absUserId: string
  absLibraryId: string
  query: string
  resultsJson: string
  expiresAt: string
  createdAt: string
}

export class SearchRepository {
  constructor(private readonly db: Database.Database) {}

  create(record: SearchSessionRecord): void {
    this.db
      .prepare(
        `INSERT INTO search_sessions (id, abs_user_id, abs_library_id, query, results_json, expires_at, created_at)
         VALUES (@id, @absUserId, @absLibraryId, @query, @resultsJson, @expiresAt, @createdAt)`
      )
      .run(record)
  }

  findById(id: string): SearchSessionRecord | undefined {
    const row = this.db.prepare('SELECT * FROM search_sessions WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    if (!row) return undefined
    return {
      id: row.id as string,
      absUserId: row.abs_user_id as string,
      absLibraryId: row.abs_library_id as string,
      query: row.query as string,
      resultsJson: row.results_json as string,
      expiresAt: row.expires_at as string,
      createdAt: row.created_at as string
    }
  }

  /** Deletes expired sessions, skipping any id in `referencedIds` -- an acquisition's
   * search_session_id is a FOREIGN KEY, so a still-referenced session must survive even
   * past its search TTL (the acquisition itself is the source of truth once submitted). */
  deleteExpiredExcept(nowIso: string, referencedIds: string[]): number {
    if (referencedIds.length === 0) {
      const info = this.db.prepare('DELETE FROM search_sessions WHERE expires_at < ?').run(nowIso)
      return info.changes
    }
    const placeholders = referencedIds.map(() => '?').join(', ')
    const info = this.db
      .prepare(`DELETE FROM search_sessions WHERE expires_at < ? AND id NOT IN (${placeholders})`)
      .run(nowIso, ...referencedIds)
    return info.changes
  }
}
