import { describe, expect, it } from 'vitest'
import { openDatabase } from '../db/database'
import { AcquisitionRepository, type AcquisitionRecord } from '../db/acquisitionRepository'
import { SearchRepository } from '../db/searchRepository'
import { LibrarrClient } from '../adapters/librarrClient'
import { Reconciler } from './reconciler'
import type { LibrarrDownloadStatus } from '../adapters/librarrSchemas'

function record(overrides: Partial<AcquisitionRecord> = {}): AcquisitionRecord {
  const now = '2026-08-24T00:00:00.000Z'
  return {
    id: 'a1',
    absUserId: 'u1',
    absLibraryId: 'lib1',
    idempotencyKey: 'k1',
    searchSessionId: 's1',
    releaseId: 'r1',
    title: 'Book',
    author: 'Author',
    state: 'submitted',
    trackingKey: 'torrent:0123456789abcdef0123456789abcdef01234567',
    createdAt: now,
    updatedAt: now,
    ...overrides
  }
}

function harness(downloads: LibrarrDownloadStatus[], nowMs: number) {
  const db = openDatabase(':memory:')
  const searchRepo = new SearchRepository(db)
  searchRepo.create({
    id: 's1',
    absUserId: 'u1',
    absLibraryId: 'lib1',
    query: 'x',
    resultsJson: '[]',
    expiresAt: '2026-08-24T01:00:00.000Z',
    createdAt: '2026-08-24T00:00:00.000Z'
  })
  const repo = new AcquisitionRepository(db)
  const fetcher = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input)
    if (url.includes('/api/downloads')) {
      return new Response(JSON.stringify({ downloads }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    throw new Error(`unexpected URL: ${url}`)
  }) as unknown as typeof fetch
  const librarr = new LibrarrClient({ baseUrl: 'http://librarr:5050', apiKey: 'k', fetcher })
  let clock = nowMs
  const reconciler = new Reconciler({
    librarr,
    repo,
    searchRepo,
    intervalMs: 60_000,
    stallTimeoutSeconds: 1800,
    now: () => clock,
    onEvent: () => {}
  })
  return {
    db,
    repo,
    reconciler,
    advanceClock: (ms: number) => {
      clock += ms
    }
  }
}

describe('Reconciler', () => {
  let h: ReturnType<typeof harness>

  it('advances a matched torrent to downloading with clamped progress', async () => {
    h = harness([{ source: 'x', title: 'Book', status: 'downloading', progress: 42, hash: '0123456789abcdef0123456789abcdef01234567' }], Date.now())
    h.repo.create(record({ state: 'submitted' }))
    await h.reconciler.runOnce()
    const updated = h.repo.findById('a1')
    expect(updated?.state).toBe('downloading')
    expect(updated?.progressPercent).toBe(42)
  })

  it('moves a row with no matching Librarr job to needs_attention (missing-job-without-staging)', async () => {
    h = harness([], Date.now())
    h.repo.create(record({ state: 'submitted' }))
    await h.reconciler.runOnce()
    const updated = h.repo.findById('a1')
    expect(updated?.state).toBe('needs_attention')
    expect(updated?.errorCode).toBe('librarr_job_missing')
  })

  it('leaves an already-processing row alone when it drops off /api/downloads (missing-job-with-staging = expected completion)', async () => {
    h = harness([], Date.now())
    h.repo.create(record({ state: 'processing', lastSuccessfulStage: 'processing' }))
    await h.reconciler.runOnce()
    const updated = h.repo.findById('a1')
    expect(updated?.state).toBe('processing')
  })

  it('never regresses a row to an earlier stage on a stale/regressive provider status', async () => {
    h = harness([{ source: 'x', title: 'Book', status: 'queued', hash: '0123456789abcdef0123456789abcdef01234567' }], Date.now())
    h.repo.create(record({ state: 'downloading', progressPercent: 55 }))
    await h.reconciler.runOnce()
    const updated = h.repo.findById('a1')
    expect(updated?.state).toBe('downloading')
  })

  it('fails a download stalled at 0 bytes past the stall timeout (FND-00410)', async () => {
    const startMs = Date.parse('2026-08-24T00:00:00.000Z')
    h = harness([{ source: 'x', title: 'Book', status: 'downloading', progress: 0, hash: '0123456789abcdef0123456789abcdef01234567' }], startMs)
    h.repo.create(record({ state: 'downloading' }))

    await h.reconciler.runOnce() // first observation: marks stalledSince, stays downloading
    expect(h.repo.findById('a1')?.state).toBe('downloading')
    expect(h.repo.findById('a1')?.stalledSince).toBeTruthy()

    h.advanceClock(1800 * 1000 + 1000)
    await h.reconciler.runOnce()
    const updated = h.repo.findById('a1')
    expect(updated?.state).toBe('failed')
    expect(updated?.errorCode).toBe('download_stalled')
    expect(updated?.errorRetryable).toBe(true)
  })

  it('clears stalledSince once progress resumes', async () => {
    h = harness([{ source: 'x', title: 'Book', status: 'downloading', progress: 0, hash: '0123456789abcdef0123456789abcdef01234567' }], Date.now())
    h.repo.create(record({ state: 'downloading', stalledSince: '2026-08-24T00:00:00.000Z' }))
    // Replace fetcher output with progress by rebuilding the harness downloads inline isn't
    // supported here, so directly assert the stalledSince-clearing branch via a second
    // reconciler configured with progress > 0.
    const db2 = openDatabase(':memory:')
    const searchRepo2 = new SearchRepository(db2)
    searchRepo2.create({
      id: 's1',
      absUserId: 'u1',
      absLibraryId: 'lib1',
      query: 'x',
      resultsJson: '[]',
      expiresAt: '2026-08-24T01:00:00.000Z',
      createdAt: '2026-08-24T00:00:00.000Z'
    })
    const repo2 = new AcquisitionRepository(db2)
    repo2.create(record({ state: 'downloading', stalledSince: '2026-08-24T00:00:00.000Z' }))
    const fetcher2 = (async () =>
      new Response(
        JSON.stringify({ downloads: [{ source: 'x', title: 'Book', status: 'downloading', progress: 10, hash: '0123456789abcdef0123456789abcdef01234567' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )) as unknown as typeof fetch
    const reconciler2 = new Reconciler({
      librarr: new LibrarrClient({ baseUrl: 'http://librarr:5050', apiKey: 'k', fetcher: fetcher2 }),
      repo: repo2,
      intervalMs: 60_000,
      stallTimeoutSeconds: 1800
    })
    await reconciler2.runOnce()
    expect(repo2.findById('a1')?.stalledSince).toBeNull()
    db2.close()
  })

  it('completed status maps to processing (staging step, not yet promoted to available)', async () => {
    h = harness([{ source: 'x', title: 'Book', status: 'completed', progress: 100, hash: '0123456789abcdef0123456789abcdef01234567' }], Date.now())
    h.repo.create(record({ state: 'downloading' }))
    await h.reconciler.runOnce()
    expect(h.repo.findById('a1')?.state).toBe('processing')
  })

  it('cleanup does not crash pruning an expired search session still FK-referenced by a terminal (in-retention) acquisition', async () => {
    const db = openDatabase(':memory:')
    const searchRepo = new SearchRepository(db)
    searchRepo.create({
      id: 's1',
      absUserId: 'u1',
      absLibraryId: 'lib1',
      query: 'x',
      resultsJson: '[]',
      expiresAt: '2026-08-24T00:15:00.000Z', // long expired relative to `now` below
      createdAt: '2026-08-24T00:00:00.000Z'
    })
    const repo = new AcquisitionRepository(db)
    // Terminal (`available`) but well within history retention -- this is exactly the shape
    // a real disposable-library-test acquisition takes hours after it completes.
    repo.create(record({ state: 'available', updatedAt: '2026-08-24T00:10:00.000Z' }))
    const reconciler = new Reconciler({
      librarr: new LibrarrClient({
        baseUrl: 'http://librarr:5050',
        apiKey: 'k',
        fetcher: (async () => new Response(JSON.stringify({ downloads: [] }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
      }),
      repo,
      searchRepo,
      intervalMs: 60_000,
      stallTimeoutSeconds: 1800,
      historyRetentionSeconds: 604800, // 7 days -- the terminal row above is nowhere near this
      now: () => Date.parse('2026-08-25T00:00:00.000Z')
    })
    await expect(reconciler.runOnce()).resolves.not.toThrow()
    expect(searchRepo.findById('s1')).toBeDefined()
    db.close()
  })
})
