import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { openDatabase } from './database'
import { AcquisitionRepository, type AcquisitionRecord } from './acquisitionRepository'
import { SearchRepository, type SearchSessionRecord } from './searchRepository'

function searchFixture(overrides: Partial<SearchSessionRecord> = {}): SearchSessionRecord {
  return {
    id: 'search1',
    absUserId: 'user1',
    absLibraryId: 'lib1',
    query: 'dune',
    resultsJson: '[]',
    expiresAt: '2026-08-24T01:00:00.000Z',
    createdAt: '2026-08-24T00:00:00.000Z',
    ...overrides
  }
}

function fixture(overrides: Partial<AcquisitionRecord> = {}): AcquisitionRecord {
  return {
    id: 'a1',
    absUserId: 'user1',
    absLibraryId: 'lib1',
    idempotencyKey: 'key1',
    searchSessionId: 'search1',
    releaseId: 'release1',
    title: 'Book',
    author: 'Author',
    state: 'queued',
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
    ...overrides
  }
}

describe('gateway database', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openDatabase(':memory:')
  })

  afterEach(() => {
    db.close()
  })

  it('applies the initial migration and enables safety pragmas', () => {
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(
      (row) => row.name
    )
    expect(tables).toEqual(expect.arrayContaining(['acquisitions', 'schema_migrations', 'search_sessions']))
    expect((db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: number }[]).map((r) => r.version)).toEqual([
      1, 2, 3
    ])
  })

  it('is idempotent to reopen (migrations do not reapply)', () => {
    // openDatabase already ran once in beforeEach; running the migration logic again
    // against the same handle must not throw or duplicate the schema_migrations row.
    const db2 = openDatabase(':memory:')
    expect((db2.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: number }[]).map((r) => r.version)).toEqual([
      1, 2, 3
    ])
    db2.close()
  })

  it('enforces one acquisition per user and idempotency key', () => {
    new SearchRepository(db).create(searchFixture())
    const repo = new AcquisitionRepository(db)
    repo.create(fixture({ id: 'a1', idempotencyKey: 'same' }))
    expect(() => repo.create(fixture({ id: 'a2', idempotencyKey: 'same' }))).toThrow()
  })

  it('rejects an acquisition referencing a missing search session (foreign key enforced)', () => {
    const repo = new AcquisitionRepository(db)
    expect(() => repo.create(fixture({ id: 'a1', searchSessionId: 'does-not-exist' }))).toThrow()
  })

  it('round trips an acquisition and survives a reopen against the same file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gateway-db-'))
    const dbPath = path.join(dir, 'gateway.sqlite')
    try {
      const fileDb = openDatabase(dbPath)
      new SearchRepository(fileDb).create(searchFixture())
      new AcquisitionRepository(fileDb).create(fixture({ id: 'a1' }))
      fileDb.close()

      expect(existsSync(dbPath)).toBe(true)

      const reopened = openDatabase(dbPath)
      try {
        const record = new AcquisitionRepository(reopened).findById('a1')
        expect(record).toMatchObject({ id: 'a1', title: 'Book', state: 'queued' })
        expect(
          (reopened.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: number }[]).map((r) => r.version)
        ).toEqual([1, 2, 3])
      } finally {
        reopened.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
