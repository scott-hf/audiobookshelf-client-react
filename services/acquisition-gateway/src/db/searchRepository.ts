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
}
