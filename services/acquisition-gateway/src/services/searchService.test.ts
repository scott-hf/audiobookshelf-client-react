import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { openDatabase } from '../db/database'
import { SearchRepository } from '../db/searchRepository'
import { LibrarrClient } from '../adapters/librarrClient'
import { SearchService } from './searchService'
import { DomainError } from '../domain/errors'

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures', 'librarr')
const searchFixture = JSON.parse(readFileSync(path.join(FIXTURES, 'search-audiobooks.json'), 'utf-8'))

function fixtureFetcher(): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(searchFixture), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
}

describe('SearchService', () => {
  let db: Database.Database
  let service: SearchService
  let clockMs: number

  beforeEach(() => {
    db = openDatabase(':memory:')
    clockMs = Date.parse('2026-08-24T00:00:00.000Z')
    service = new SearchService({
      librarr: new LibrarrClient({ baseUrl: 'http://librarr:5050', apiKey: 'k', fetcher: fixtureFetcher() }),
      repo: new SearchRepository(db),
      ttlSeconds: 900,
      now: () => clockMs
    })
  })

  it('returns opaque IDs, never leaks a magnet URI, and marks requestability correctly', async () => {
    const response = await service.search('u1', 'lib1', 'Project Hail Mary')

    expect(response.searchSessionId).toMatch(/^search_[A-Za-z0-9_-]{22}$/)
    for (const result of response.results) {
      expect(result.releaseId).toMatch(/^release_[A-Za-z0-9_-]{22}$/)
    }
    expect(JSON.stringify(response)).not.toContain('magnet:')

    // torrent (info_hash+magnet), AudioBookBay (abb_url only), NZB (never requestable here).
    expect(response.results[0].requestable).toBe(true)
    expect(response.results[1].requestable).toBe(true)
    expect(response.results[1].sourceLabel).toBe('audiobook')
    expect(response.results[2].requestable).toBe(false)
  })

  it('resolves a release back to its exact raw snapshot entry', async () => {
    const response = await service.search('u1', 'lib1', 'Project Hail Mary')
    const { raw } = service.resolveRelease('u1', response.searchSessionId, response.results[0].releaseId)
    expect(raw.info_hash).toBe('0123456789abcdef0123456789abcdef01234567')
  })

  it('refuses to resolve for the wrong user', async () => {
    const response = await service.search('u1', 'lib1', 'Project Hail Mary')
    expect(() => service.resolveRelease('u2', response.searchSessionId, response.results[0].releaseId)).toThrow(DomainError)
  })

  it('refuses an expired snapshot', async () => {
    const response = await service.search('u1', 'lib1', 'Project Hail Mary')
    clockMs += 901_000
    expect(() => service.resolveRelease('u1', response.searchSessionId, response.results[0].releaseId)).toThrowError(
      /search_expired/
    )
  })
})
