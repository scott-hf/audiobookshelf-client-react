import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { openDatabase } from '../db/database'
import { SearchRepository } from '../db/searchRepository'
import { AcquisitionRepository } from '../db/acquisitionRepository'
import { LibrarrClient } from '../adapters/librarrClient'
import { SearchService } from './searchService'
import { AcquisitionService } from './acquisitionService'
import { DomainError } from '../domain/errors'

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures', 'librarr')
const searchFixture = JSON.parse(readFileSync(path.join(FIXTURES, 'search-audiobooks.json'), 'utf-8'))

interface Harness {
  db: Database.Database
  searchService: SearchService
  acquisitionService: AcquisitionService
  acquisitionRepo: AcquisitionRepository
  submitCalls: number
  submitResponse: { success: boolean; title: string; error?: string; hash?: string; job_id?: string; nzo_id?: string }
}

function buildHarness(): Harness {
  const db = openDatabase(':memory:')
  const searchRepo = new SearchRepository(db)
  const acquisitionRepo = new AcquisitionRepository(db)
  let submitCalls = 0
  const submitResponse: Harness['submitResponse'] = { success: true, title: 'Project Hail Mary', hash: '0123456789abcdef0123456789abcdef01234567' }

  const fetcher = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input)
    if (url.includes('/api/search/audiobooks')) {
      return new Response(JSON.stringify(searchFixture), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/api/download/audiobook')) {
      submitCalls++
      const status = submitResponse.success === false && submitResponse.error === 'SABnzbd not configured' ? 400 : 200
      return new Response(JSON.stringify(submitResponse), { status, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/api/downloads/jobs/')) {
      return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/api/downloads/torrent/') || url.includes('/api/downloads/novel/')) {
      return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    throw new Error(`unexpected URL in test fetcher: ${url}`)
  }) as unknown as typeof fetch

  const librarr = new LibrarrClient({ baseUrl: 'http://librarr:5050', apiKey: 'k', fetcher })
  const searchService = new SearchService({ librarr, repo: searchRepo, ttlSeconds: 900 })
  const acquisitionService = new AcquisitionService({ librarr, repo: acquisitionRepo, searchService })

  return {
    db,
    searchService,
    acquisitionService,
    acquisitionRepo,
    get submitCalls() {
      return submitCalls
    },
    submitResponse
  }
}

describe('AcquisitionService', () => {
  let h: Harness

  beforeEach(() => {
    h = buildHarness()
  })

  it('creates exactly one Librarr job for concurrent repeats of the same idempotency key', async () => {
    const search = await h.searchService.search('u1', 'lib1', 'Project Hail Mary')
    const body = { searchSessionId: search.searchSessionId, releaseId: search.results[0].releaseId, idempotencyKey: crypto.randomUUID() }

    const [first, second] = await Promise.all([
      h.acquisitionService.create({ id: 'u1' }, 'lib1', body),
      h.acquisitionService.create({ id: 'u1' }, 'lib1', body)
    ])

    expect(first.id).toBe(second.id)
    expect(h.submitCalls).toBe(1)
  })

  it('submits and reaches submitted with a torrent: tracking key derived from the submit-response hash', async () => {
    const search = await h.searchService.search('u1', 'lib1', 'Project Hail Mary')
    const body = { searchSessionId: search.searchSessionId, releaseId: search.results[0].releaseId, idempotencyKey: crypto.randomUUID() }
    const acquisition = await h.acquisitionService.create({ id: 'u1' }, 'lib1', body)
    expect(acquisition.state).toBe('submitted')
    const record = h.acquisitionRepo.findById(acquisition.id)
    expect(record?.trackingKey).toBe('torrent:0123456789abcdef0123456789abcdef01234567')
  })

  it('rejects an NZB result as not requestable in this deployment (no SABnzbd)', async () => {
    const search = await h.searchService.search('u1', 'lib1', 'Project Hail Mary')
    const nzbRelease = search.results[2]
    expect(nzbRelease.requestable).toBe(false)
    const body = { searchSessionId: search.searchSessionId, releaseId: nzbRelease.releaseId, idempotencyKey: crypto.randomUUID() }
    await expect(h.acquisitionService.create({ id: 'u1' }, 'lib1', body)).rejects.toMatchObject({ code: 'release_not_trackable' })
  })

  it('accepts an AudioBookBay result keyed only by abb_url (no info_hash/magnet at search time)', async () => {
    const search = await h.searchService.search('u1', 'lib1', 'Project Hail Mary')
    const abbRelease = search.results[1]
    expect(abbRelease.requestable).toBe(true)
    const body = { searchSessionId: search.searchSessionId, releaseId: abbRelease.releaseId, idempotencyKey: crypto.randomUUID() }
    const acquisition = await h.acquisitionService.create({ id: 'u1' }, 'lib1', body)
    // Librarr's submit response still carries a hash for this fixture -- confirms the
    // request body (raw snapshot incl. abb_url) round-tripped without the client requiring
    // a pre-existing info_hash.
    expect(acquisition.state).toBe('submitted')
  })

  it('goes to needs_attention, never title matching, when Librarr gives no trackable identity', async () => {
    h.submitResponse.hash = undefined
    const search = await h.searchService.search('u1', 'lib1', 'Project Hail Mary')
    // AudioBookBay result: no info_hash/magnet_url to fall back to, so with the submit
    // response's hash/job_id/nzo_id all absent there is truly nothing to key on.
    const body = { searchSessionId: search.searchSessionId, releaseId: search.results[1].releaseId, idempotencyKey: crypto.randomUUID() }
    const acquisition = await h.acquisitionService.create({ id: 'u1' }, 'lib1', body)
    expect(acquisition.state).toBe('needs_attention')
    expect(acquisition.error?.code).toBe('release_not_trackable')
  })

  it('surfaces the SABnzbd-not-configured submit failure as a stable non-retryable error', async () => {
    h.submitResponse.success = false
    h.submitResponse.error = 'SABnzbd not configured'
    const search = await h.searchService.search('u1', 'lib1', 'Project Hail Mary')
    const body = { searchSessionId: search.searchSessionId, releaseId: search.results[0].releaseId, idempotencyKey: crypto.randomUUID() }
    const acquisition = await h.acquisitionService.create({ id: 'u1' }, 'lib1', body)
    expect(acquisition.state).toBe('failed')
    expect(acquisition.error).toMatchObject({ code: 'sabnzbd_not_configured', retryable: false })
  })

  it('cancel deletes the torrent on Librarr and marks the row cancelled', async () => {
    const search = await h.searchService.search('u1', 'lib1', 'Project Hail Mary')
    const body = { searchSessionId: search.searchSessionId, releaseId: search.results[0].releaseId, idempotencyKey: crypto.randomUUID() }
    const created = await h.acquisitionService.create({ id: 'u1' }, 'lib1', body)
    const cancelled = await h.acquisitionService.cancel({ id: 'u1' }, created.id)
    expect(cancelled.state).toBe('cancelled')
  })

  it('a missing or foreign acquisition raises the same acquisition_not_found error', () => {
    expect(() => h.acquisitionService.get({ id: 'u1' }, 'does-not-exist')).toThrow(DomainError)
    expect(() => h.acquisitionService.get({ id: 'u1' }, 'does-not-exist')).toThrow(
      expect.objectContaining({ code: 'acquisition_not_found' })
    )
  })

  it('retry resubmits from the persisted snapshot for a torrent: tracking key, not a Librarr retry endpoint', async () => {
    const search = await h.searchService.search('u1', 'lib1', 'Project Hail Mary')
    const body = { searchSessionId: search.searchSessionId, releaseId: search.results[0].releaseId, idempotencyKey: crypto.randomUUID() }
    const created = await h.acquisitionService.create({ id: 'u1' }, 'lib1', body)
    // Force it into a retryable failure.
    h.acquisitionRepo.update(created.id, { state: 'failed', errorCode: 'librarr_unreachable', errorMessage: 'x', errorRetryable: true })

    const retried = await h.acquisitionService.retry({ id: 'u1' }, created.id)
    expect(retried.state).toBe('submitted')
    expect(h.submitCalls).toBe(2) // one from create, one from retry
  })
})
