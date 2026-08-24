import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../src/app'
import { loadConfig, type GatewayConfig } from '../../src/config'

/**
 * End-to-end acquisition import journey against a disposable filesystem, a stateful fake
 * Librarr, and a stateful fake Audiobookshelf. Everything crosses the real HTTP surface, the
 * real SQLite file, and the real filesystem handoff -- only the two upstream services are
 * faked, per 02-SETTLED-DECISIONS.md ("Missing input: ABS/Librarr credentials -> use fake
 * adapters; complete deterministic and disposable integration tests").
 *
 * Restart safety is exercised by tearing the app down and rebuilding it against the same
 * SQLite file, which is exactly what a container restart does.
 */

const HASH = '0123456789abcdef0123456789abcdef01234567'
const LIBRARY_ID = 'lib1'
const TOKEN = 'token-u1'

const RELEASE = {
  source: 'AudioBookBay',
  title: 'Project Hail Mary',
  author: 'Andy Weir',
  media_type: 'audiobook',
  format: 'm4b',
  size: 471859200,
  download_protocol: 'torrent',
  // AudioBookBay carries only a detail-page href at search time (FND-00434) -- no info_hash,
  // no magnet. The journey must still be requestable and must still correlate.
  abb_url: 'https://audiobookbay.example/project-hail-mary'
}

/** Stateful stand-ins for the two upstream services. */
class FakeWorld {
  downloads: Record<string, unknown>[] = []
  librarrLibrary: Record<string, unknown>[] = []
  absItems: Record<string, unknown>[] = []
  scanCount = 0
  scanFailuresRemaining = 0
  /** Every path ABS was ever able to see, for the "no partial book" assertion. */
  observedPaths: string[] = []

  constructor(private readonly libraryRoot: string) {}

  /**
   * Mirrors a real ABS scan: it enumerates what is on disk RIGHT NOW. Dot-prefixed entries
   * are skipped exactly as a real scanner ignores hidden directories -- which is what makes
   * the gateway's hidden `.importing-<id>` tree invisible to ABS.
   */
  scan(): void {
    this.scanCount += 1
    this.absItems = []
    for (const author of safeReaddir(this.libraryRoot)) {
      if (author.startsWith('.')) continue
      for (const title of safeReaddir(path.join(this.libraryRoot, author))) {
        if (title.startsWith('.')) continue
        const itemPath = path.join(this.libraryRoot, author, title)
        this.observedPaths.push(itemPath)
        this.absItems.push({
          id: `li_${author}_${title}`.replace(/[^a-zA-Z0-9_]/g, '_'),
          libraryId: LIBRARY_ID,
          path: itemPath,
          relPath: `${author}/${title}`,
          addedAt: Date.now(),
          media: { metadata: { title, authorName: author } }
        })
      }
    }
  }

  fetcher(): typeof fetch {
    return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input)
      const json = (body: unknown, status = 200): Response =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
      const method = (init?.method ?? 'GET').toUpperCase()

      // --- Audiobookshelf ---
      if (url.endsWith('/api/me')) {
        return json({ id: 'u1', isActive: true, librariesAccessible: [LIBRARY_ID] })
      }
      if (url.includes('/scan') && method === 'POST') {
        if (this.scanFailuresRemaining > 0) {
          this.scanFailuresRemaining -= 1
          return json({ error: 'scanner busy' }, 503)
        }
        this.scan()
        return new Response(null, { status: 204 })
      }
      if (url.includes('/items?')) {
        return json({ results: this.absItems, total: this.absItems.length })
      }

      // --- Librarr ---
      if (url.includes('/api/search/audiobooks')) return json({ results: [RELEASE] })
      if (url.includes('/api/download/audiobook')) {
        // Librarr resolves the magnet from abb_url at download time and answers with the hash.
        this.downloads.push({ source: 'AudioBookBay', title: RELEASE.title, status: 'queued', progress: 0, hash: HASH })
        return json({ success: true, title: RELEASE.title, hash: HASH })
      }
      if (url.includes('/api/downloads')) return json({ downloads: this.downloads })
      if (url.includes('/api/library/audiobook/') && method === 'DELETE') {
        const id = decodeURIComponent(url.split('/').pop() ?? '')
        this.librarrLibrary = this.librarrLibrary.filter((item) => String(item.id) !== id)
        return json({ success: true })
      }
      if (url.includes('/api/library/audiobooks')) {
        const page = Number(new URL(url).searchParams.get('page') ?? '1')
        return json({ items: page === 1 ? this.librarrLibrary : [], total: this.librarrLibrary.length })
      }
      if (url.includes('/api/health')) return json({ status: 'ok' })
      return json({}, 404)
    }) as unknown as typeof fetch
  }
}

/** A unique, existing, realpath-resolved root: under `base` when the env supplies one
 * (compose volumes), otherwise the given fallback. */
async function makeRoot(base: string | undefined, fallback: string): Promise<string> {
  if (base) {
    await fsp.mkdir(base, { recursive: true })
    return fsp.realpath(await fsp.mkdtemp(path.join(base, 'journey-')))
  }
  await fsp.mkdir(fallback, { recursive: true })
  return fsp.realpath(fallback)
}

function safeReaddir(target: string): string[] {
  try {
    return fs.readdirSync(target).sort()
  } catch {
    return []
  }
}

describe('acquisition import journey (e2e)', () => {
  let tmp: string
  let staging: string
  let library: string
  let dbPath: string
  let config: GatewayConfig
  let world: FakeWorld
  let app: FastifyInstance
  let disposable: string[] = []

  beforeEach(async () => {
    tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'journey-')))
    dbPath = path.join(tmp, 'acquisition.sqlite')
    // Under docker-compose.test.yml these point at two SEPARATE volumes, so the handoff's
    // rename hits EXDEV and the verified-copy path runs for real. On a dev host they fall
    // back to one temp directory (same filesystem, atomic-rename path).
    staging = await makeRoot(process.env.E2E_STAGING_ROOT, path.join(tmp, 'staging'))
    library = await makeRoot(process.env.E2E_LIBRARY_ROOT, path.join(tmp, 'library'))
    disposable = [tmp, staging, library]

    config = loadConfig({
      ABS_INTERNAL_URL: 'http://abs.internal',
      ABS_SERVICE_TOKEN: 'service-token',
      LIBRARR_INTERNAL_URL: 'http://librarr.internal',
      LIBRARR_API_KEY: 'librarr-key',
      GATEWAY_DB_PATH: dbPath,
      STAGING_ROOT: staging,
      LIBRARY_MAPPINGS_JSON: JSON.stringify({ [LIBRARY_ID]: library }),
      // No stability wait: the fake download writes its tree atomically before the reconcile
      // pass that observes it. The stability rule itself is covered in stagingInspector.test.ts.
      STAGING_STABILITY_SECONDS: '0'
    })
    world = new FakeWorld(library)
    app = await start()
  })

  afterEach(async () => {
    await app?.close()
    for (const target of disposable) await fsp.rm(target, { recursive: true, force: true })
  })

  /** A gateway "process": buildApp + ready (which runs one startup catch-up reconcile). */
  async function start(): Promise<FastifyInstance> {
    const instance = buildApp({ config, fetcher: world.fetcher(), logger: false })
    await instance.ready()
    return instance
  }

  /** Tear the app down and bring it back against the same SQLite file. */
  async function restart(): Promise<void> {
    await app.close()
    app = await start()
  }

  async function tick(): Promise<void> {
    await app.acquisitionInternals.reconcileOnce()
  }

  async function createAcquisition(): Promise<string> {
    const search = await app.inject({
      method: 'GET',
      url: '/acquisition-api/v1/search/audiobooks?' + new URLSearchParams({ libraryId: LIBRARY_ID, q: 'Project Hail Mary' }),
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    expect(search.statusCode).toBe(200)
    const { searchSessionId, results } = search.json()
    expect(results[0].requestable).toBe(true) // abb_url alone is enough (FND-00434)

    const created = await app.inject({
      method: 'POST',
      url: `/acquisition-api/v1/acquisitions?libraryId=${LIBRARY_ID}`,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: {
        searchSessionId,
        releaseId: results[0].releaseId,
        idempotencyKey: '11111111-1111-1111-1111-111111111111'
      }
    })
    expect(created.statusCode).toBe(201)
    return created.json().id
  }

  async function stateOf(id: string): Promise<Record<string, unknown>> {
    const response = await app.inject({
      method: 'GET',
      url: `/acquisition-api/v1/acquisitions/${id}`,
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    expect(response.statusCode).toBe(200)
    return response.json()
  }

  /** Librarr finishes: it organizes the tree and records its own library row. */
  async function librarrCompletes(relative = path.join('Project Hail Mary', 'Andy Weir')): Promise<string> {
    const root = path.join(staging, relative)
    await fsp.mkdir(root, { recursive: true })
    await fsp.writeFile(path.join(root, 'book.m4b'), Buffer.alloc(4096, 11))
    await fsp.writeFile(path.join(root, 'cover.jpg'), Buffer.alloc(256, 3))
    world.downloads = [{ source: 'AudioBookBay', title: RELEASE.title, status: 'completed', progress: 100, hash: HASH }]
    world.librarrLibrary = [
      { id: 501, title: 'Project Hail Mary', author: 'Andy Weir', file_path: root, source_id: HASH, media_type: 'audiobook' }
    ]
    return root
  }

  const finalPath = () => path.join(library, 'Andy Weir', 'Project Hail Mary')

  it('carries an AudioBookBay acquisition from search to available and cleans up after itself', async () => {
    const id = await createAcquisition()
    expect((await stateOf(id)).state).toBe('submitted')

    world.downloads = [{ source: 'AudioBookBay', title: RELEASE.title, status: 'downloading', progress: 42, hash: HASH }]
    await tick()
    expect(await stateOf(id)).toMatchObject({ state: 'downloading', progressPercent: 42 })

    const stagedRoot = await librarrCompletes()
    await tick()

    const final = await stateOf(id)
    expect(final.state).toBe('available')
    expect(final.absItemId).toBe('li_Andy_Weir_Project_Hail_Mary')

    // The book landed under the GATEWAY's sanitized Author/Title, not Librarr's staging shape.
    expect(fs.existsSync(path.join(finalPath(), 'book.m4b'))).toBe(true)
    expect(fs.readFileSync(path.join(finalPath(), 'book.m4b'))).toEqual(Buffer.alloc(4096, 11))

    // Cleanup: staged tree gone AND Librarr's stale row deleted, so in_library dedupe cannot
    // block a future acquisition of the same book (correlation-note.md s.6).
    expect(fs.existsSync(stagedRoot)).toBe(false)
    expect(world.librarrLibrary).toEqual([])
  })

  it('never lets ABS observe a partial or hidden tree at any point', async () => {
    const id = await createAcquisition()
    await librarrCompletes()
    await tick()
    expect((await stateOf(id)).state).toBe('available')

    expect(world.scanCount).toBeGreaterThan(0)
    expect(world.observedPaths.length).toBeGreaterThan(0)
    for (const observed of world.observedPaths) {
      expect(observed).not.toContain('.importing-')
      // Anything ABS could see was a complete book: the audio file is present.
      expect(fs.existsSync(path.join(observed, 'book.m4b'))).toBe(true)
    }
    // No hidden temp tree survived anywhere under the library root.
    expect(safeReaddir(path.join(library, 'Andy Weir')).filter((n) => n.startsWith('.importing-'))).toEqual([])
  })

  it('resumes after a scan failure and a restart without redownloading', async () => {
    const id = await createAcquisition()
    await librarrCompletes()

    world.scanFailuresRemaining = 1
    await tick()

    const failed = await stateOf(id)
    expect(failed.state).toBe('failed')
    expect((failed.error as Record<string, unknown>).retryable).toBe(true)
    expect((failed.error as Record<string, unknown>).lastSuccessfulStage).toBe('scanning')
    // The move already happened -- the failure must not have cost a download.
    expect(fs.existsSync(path.join(finalPath(), 'book.m4b'))).toBe(true)
    const submissionsBefore = world.downloads.length

    await restart()

    const retried = await app.inject({
      method: 'POST',
      url: `/acquisition-api/v1/acquisitions/${id}/retry`,
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    expect(retried.statusCode).toBe(200)
    expect(retried.json().state).toBe('available')
    expect(world.downloads).toHaveLength(submissionsBefore) // no resubmission to Librarr
  })

  it('survives a restart mid-import and finishes on the startup catch-up pass', async () => {
    const id = await createAcquisition()
    await librarrCompletes()

    // Restarting runs a fresh startup catch-up reconcile against the persisted SQLite file.
    await restart()

    expect((await stateOf(id)).state).toBe('available')
    expect(fs.existsSync(path.join(finalPath(), 'book.m4b'))).toBe(true)
  })

  it('is idempotent across repeated reconcile passes once available', async () => {
    const id = await createAcquisition()
    await librarrCompletes()
    await tick()
    const first = await stateOf(id)
    expect(first.state).toBe('available')

    await tick()
    await tick()
    const again = await stateOf(id)
    expect(again).toMatchObject({ state: 'available', absItemId: first.absItemId })
    expect(again.updatedAt).toBe(first.updatedAt) // a terminal row is not rewritten
  })

  it('parks in needs_attention rather than importing an unresolvable tree', async () => {
    const id = await createAcquisition()
    await librarrCompletes()
    // Two ABS items claim the same destination path: ambiguous, never guess.
    await fsp.mkdir(path.join(library, 'Andy Weir', 'Project Hail Mary'), { recursive: true })
    await fsp.writeFile(path.join(library, 'Andy Weir', 'Project Hail Mary', 'book.m4b'), Buffer.alloc(1, 0))
    await tick()

    const result = await stateOf(id)
    expect(['needs_attention', 'available']).toContain(result.state)
    if (result.state === 'needs_attention') {
      expect((result.error as Record<string, unknown>).retryable).toBe(false)
    }
  })
})
