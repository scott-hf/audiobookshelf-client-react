import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { LibrarrClient, LibrarrTimeoutError } from '../adapters/librarrClient'
import { buildApp } from '../app'
import { loadConfig } from '../config'

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures', 'librarr')
const readFixture = (name: string) => JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf-8'))
const optionsFixture = readFixture('discover-options.json')
const browseFixture = readFixture('discover-browse.json')
const outageFixture = readFixture('discover-browse-upstream-unavailable.json')

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

describe('discover routes', () => {
  let stagingDir: string
  let app: FastifyInstance
  /** What the fake Librarr answers next; each test sets it. */
  let librarrReply: () => Response
  let librarrUrls: string[]

  beforeEach(() => {
    stagingDir = mkdtempSync(path.join(tmpdir(), 'gateway-discover-'))
    librarrUrls = []
    librarrReply = () => json({}, 404)
    const config = loadConfig({
      ABS_INTERNAL_URL: 'http://abs.internal',
      ABS_SERVICE_TOKEN: 'service-token',
      LIBRARR_INTERNAL_URL: 'http://librarr.internal',
      LIBRARR_API_KEY: 'librarr-key',
      GATEWAY_DB_PATH: ':memory:',
      STAGING_ROOT: stagingDir,
      LIBRARY_MAPPINGS_JSON: JSON.stringify({ lib1: path.join(stagingDir, '..', 'lib1') })
    })
    const absFetcher = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).endsWith('/api/me')) {
        const headers = init?.headers as Headers | Record<string, string> | undefined
        const auth = headers instanceof Headers ? (headers.get('authorization') ?? '') : (headers?.authorization ?? '')
        return auth === 'Bearer good-token' ? json({ id: 'u1', isActive: true, librariesAccessible: ['lib1'] }) : json({}, 401)
      }
      return json({}, 404)
    }) as unknown as typeof fetch
    const librarrFetcher = (async (input: Parameters<typeof fetch>[0]) => {
      librarrUrls.push(String(input))
      // The reconciler's startup pass lists downloads; keep that quiet.
      if (String(input).includes('/api/downloads')) return json({ downloads: [] })
      return librarrReply()
    }) as unknown as typeof fetch
    app = buildApp({ config, fetcher: absFetcher, librarrFetcher, logger: false })
  })

  afterEach(async () => {
    await app?.close()
    rmSync(stagingDir, { recursive: true, force: true })
  })

  const get = (url: string, token: string | null = 'good-token') =>
    app.inject({
      method: 'GET',
      url: `/acquisition-api/v1${url}`,
      headers: token ? { authorization: `Bearer ${token}` } : {}
    })
  const discoverUrls = () => librarrUrls.filter((u) => u.includes('/api/discover/')).map((u) => new URL(u))

  it('rejects unauthenticated callers on both routes', async () => {
    expect((await get('/discover/options', null)).statusCode).toBe(401)
    expect((await get('/discover/browse?catalog=popular', null)).statusCode).toBe(401)
    expect((await get('/discover/options', 'bad-token')).statusCode).toBe(401)
    expect(discoverUrls()).toHaveLength(0)
  })

  describe('options', () => {
    it('returns the catalogs and genres without store-able caching', async () => {
      librarrReply = () => json(optionsFixture)
      const response = await get('/discover/options')

      expect(response.statusCode).toBe(200)
      expect(response.headers['cache-control']).toBe('no-store')
      const body = response.json()
      expect(body.catalogs).toHaveLength(3)
      expect(body.genres).toContainEqual({ id: 'science fiction', label: 'Science fiction' })
      // The Librarr envelope does not leak through.
      expect(body).not.toHaveProperty('status')
      expect(body).not.toHaveProperty('error')
    })

    it('maps a Librarr 404 (an older Librarr) to 404 discover_not_supported', async () => {
      librarrReply = () => json({ error: 'not found' }, 404)
      const response = await get('/discover/options')
      expect(response.statusCode).toBe(404)
      expect(response.json()).toMatchObject({ code: 'discover_not_supported', retryable: false })
    })
  })

  describe('browse', () => {
    it('passes a success through, labelled with the request', async () => {
      librarrReply = () => json({ ...browseFixture, catalog: 'popular', genre: '', offset: 0 })
      const response = await get('/discover/browse?catalog=popular&offset=0')

      expect(response.statusCode).toBe(200)
      expect(response.headers['cache-control']).toBe('no-store')
      const body = response.json()
      expect(body).toMatchObject({ status: 'ok', catalog: 'popular', genre: '', offset: 0, nextOffset: 20, partial: false })
      expect(body).not.toHaveProperty('error')
      expect(body.items).toHaveLength(2)
      expect(body.items[0]).toMatchObject({ key: '/works/OL17930368W', title: 'Atomic Habits', year: 2016 })
      expect(body.items[1]).toMatchObject({ coverUrl: null, year: null })
    })

    describe('echo check', () => {
      it.each([
        ['offset', { offset: 20, next_offset: 40 }],
        ['catalog', { catalog: 'something-else' }],
        ['genre', { genre: 'other' }]
      ])('fails with 502 discover_bad_response when Librarr echoes a different %s', async (_name, echo) => {
        librarrReply = () => json({ ...browseFixture, ...echo })
        const response = await get('/discover/browse?catalog=popular&offset=0')

        expect(response.statusCode).toBe(502)
        expect(response.json()).toEqual({
          code: 'discover_bad_response',
          message: 'Librarr returned an unexpected response',
          retryable: false,
          lastSuccessfulStage: null
        })
        // Nothing from the mismatched reply is served.
        expect(response.json()).not.toHaveProperty('items')
        expect(response.json()).not.toHaveProperty('nextOffset')
      })

      it('still serves a success whose echo fields are all absent', async () => {
        librarrReply = () => {
          const { catalog: _c, genre: _g, offset: _o, ...rest } = browseFixture
          return json(rest)
        }
        const response = await get('/discover/browse?catalog=popular')
        expect(response.statusCode).toBe(200)
        expect(response.json()).toMatchObject({ status: 'ok', catalog: 'popular', genre: '', offset: 0, nextOffset: 20 })
        expect(response.json().items).toHaveLength(2)
      })
    })

    it('forwards catalog, genre and offset to Librarr, with genre encoded and omitted when absent', async () => {
      librarrReply = () => json({ ...browseFixture, catalog: 'new', genre: "children's", offset: 40, next_offset: 60 })
      const withGenre = await get(`/discover/browse?${new URLSearchParams({ catalog: 'new', genre: "children's", offset: '40' })}`)
      expect(withGenre.statusCode).toBe(200)
      expect(withGenre.json()).toMatchObject({ catalog: 'new', genre: "children's", offset: 40, nextOffset: 60 })
      const [first] = discoverUrls()
      expect(first.searchParams.get('genre')).toBe("children's")
      expect(first.searchParams.get('offset')).toBe('40')

      await get('/discover/browse?catalog=popular&genre=')
      const second = discoverUrls()[1]
      expect(second.searchParams.has('genre')).toBe(false)
    })

    it('maps Librarr upstream_unavailable (HTTP 200, no echoed fields) to 502 discover_upstream_unavailable', async () => {
      librarrReply = () => json(outageFixture)
      const response = await get('/discover/browse?catalog=popular')

      expect(response.statusCode).toBe(502)
      expect(response.json()).toEqual({
        code: 'discover_upstream_unavailable',
        message: expect.any(String),
        retryable: true,
        lastSuccessfulStage: null
      })
    })

    it('maps Librarr rate_limited to 429 discover_rate_limited and forwards Retry-After', async () => {
      librarrReply = () => json({ status: 'rate_limited', error: 'slow down', items: [] }, 200, { 'retry-after': '45' })
      const response = await get('/discover/browse?catalog=popular')

      expect(response.statusCode).toBe(429)
      expect(response.headers['retry-after']).toBe('45')
      expect(response.json()).toMatchObject({ code: 'discover_rate_limited', retryable: true })
    })

    it('maps rate_limited without a Retry-After header to a 429 without one', async () => {
      librarrReply = () => json({ status: 'rate_limited', error: 'slow down', items: [] })
      const response = await get('/discover/browse?catalog=popular')
      expect(response.statusCode).toBe(429)
      expect(response.headers['retry-after']).toBeUndefined()
    })

    it('keeps invalid_request as a 200 with the status, an empty page and the request echoed', async () => {
      librarrReply = () => json({ status: 'invalid_request', error: 'unknown genre', items: [] })
      const response = await get('/discover/browse?catalog=popular&genre=nonsense')

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({
        status: 'invalid_request',
        catalog: 'popular',
        genre: 'nonsense',
        offset: 0,
        nextOffset: null,
        partial: false,
        items: []
      })
    })

    it('passes an empty shelf through as 200 empty', async () => {
      librarrReply = () => json({ status: 'empty', error: '', catalog: 'popular', genre: 'fantasy', offset: 0, next_offset: null, partial: false, items: [] })
      const response = await get('/discover/browse?catalog=popular&genre=fantasy')
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({ status: 'empty', nextOffset: null, items: [] })
    })

    it('maps a Librarr HTTP 404 to 404 discover_not_supported', async () => {
      librarrReply = () => json({ error: 'not found' }, 404)
      const response = await get('/discover/browse?catalog=popular')
      expect(response.statusCode).toBe(404)
      expect(response.json()).toMatchObject({ code: 'discover_not_supported', retryable: false })
    })

    it('maps a Librarr HTTP 500 to a retryable 502', async () => {
      librarrReply = () => json({ error: 'boom' }, 500)
      const response = await get('/discover/browse?catalog=popular')
      expect(response.statusCode).toBe(502)
      expect(response.json()).toMatchObject({ code: 'librarr_error', retryable: true })
    })

    it('keeps a transport-level Librarr 429 a retryable 429 discover_rate_limited', async () => {
      librarrReply = () => json({ error: 'too many requests' }, 429)
      const response = await get('/discover/browse?catalog=popular')

      expect(response.statusCode).toBe(429)
      expect(response.json()).toEqual({
        code: 'discover_rate_limited',
        message: 'Open Library is rate limiting requests',
        retryable: true,
        lastSuccessfulStage: null
      })
    })

    it('keeps a transport-level Librarr 429 on options a retryable 429 as well', async () => {
      librarrReply = () => json({ error: 'too many requests' }, 429)
      const response = await get('/discover/options')
      expect(response.statusCode).toBe(429)
      expect(response.json()).toMatchObject({ code: 'discover_rate_limited', retryable: true })
    })

    it('aborts the Librarr request when the caller disconnects, without a 5xx', async () => {
      await app.close()
      const config = loadConfig({
        ABS_INTERNAL_URL: 'http://abs.internal',
        ABS_SERVICE_TOKEN: 'service-token',
        LIBRARR_INTERNAL_URL: 'http://librarr.internal',
        LIBRARR_API_KEY: 'librarr-key',
        GATEWAY_DB_PATH: ':memory:',
        STAGING_ROOT: stagingDir,
        LIBRARY_MAPPINGS_JSON: JSON.stringify({ lib1: path.join(stagingDir, '..', 'lib1') })
      })
      let librarrSignal: AbortSignal | undefined
      let librarrRejection: unknown
      app = buildApp({
        config,
        fetcher: (async () => json({ id: 'u1', isActive: true, librariesAccessible: ['lib1'] })) as unknown as typeof fetch,
        librarrFetcher: ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          if (!String(input).includes('/api/discover/browse')) return Promise.resolve(json({ downloads: [] }))
          librarrSignal = init?.signal ?? undefined
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              librarrRejection = Object.assign(new Error('aborted'), { name: 'AbortError' })
              reject(librarrRejection)
            })
          })
        }) as unknown as typeof fetch,
        logger: false
      })
      const statuses: number[] = []
      app.addHook('onResponse', (_request, reply, done) => {
        statuses.push(reply.statusCode)
        done()
      })
      const address = await app.listen({ port: 0, host: '127.0.0.1' })

      const caller = new AbortController()
      const call = fetch(`${address}/acquisition-api/v1/discover/browse?catalog=popular`, {
        headers: { authorization: 'Bearer good-token' },
        signal: caller.signal
      }).then(
        (response) => ({ status: response.status }),
        () => ({ status: 0 })
      )
      for (let i = 0; i < 400 && !librarrSignal; i += 1) await new Promise((resolve) => setTimeout(resolve, 5))
      expect(librarrSignal).toBeDefined()
      expect(librarrSignal?.aborted).toBe(false)

      caller.abort()
      for (let i = 0; i < 400 && !librarrSignal?.aborted; i += 1) await new Promise((resolve) => setTimeout(resolve, 5))

      expect(librarrSignal?.aborted).toBe(true)
      expect(librarrRejection).toBeDefined()
      expect((await call).status).toBe(0)
      // The gateway unwound without answering the gone caller with a 5xx.
      for (let i = 0; i < 20 && statuses.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10))
      expect(statuses.filter((status) => status >= 500)).toEqual([])
    })

    describe('Librarr timeout', () => {
      afterEach(() => {
        vi.restoreAllMocks()
        vi.useRealTimers()
      })

      it('maps a LibrarrTimeoutError from browse to a retryable 504 librarr_timeout', async () => {
        vi.spyOn(LibrarrClient.prototype, 'browseDiscover').mockRejectedValue(new LibrarrTimeoutError('/api/discover/browse', 20_000))
        const response = await get('/discover/browse?catalog=popular')

        expect(response.statusCode).toBe(504)
        expect(response.json()).toEqual({
          code: 'librarr_timeout',
          message: expect.any(String),
          retryable: true,
          lastSuccessfulStage: null
        })
      })

      it('maps a LibrarrTimeoutError from options the same way', async () => {
        vi.spyOn(LibrarrClient.prototype, 'getDiscoverOptions').mockRejectedValue(new LibrarrTimeoutError('/api/discover/options', 5_000))
        const response = await get('/discover/options')
        expect(response.statusCode).toBe(504)
        expect(response.json()).toMatchObject({ code: 'librarr_timeout', retryable: true })
      })

      it('produces the 504 end to end when Librarr hangs past the real 20s browse budget', async () => {
        librarrReply = () => {
          throw new Error('unreachable: the hanging fetcher below replaces this')
        }
        // Replace the Librarr fetcher with one that only ends when the client's own deadline aborts it.
        await app.close()
        const config = loadConfig({
          ABS_INTERNAL_URL: 'http://abs.internal',
          ABS_SERVICE_TOKEN: 'service-token',
          LIBRARR_INTERNAL_URL: 'http://librarr.internal',
          LIBRARR_API_KEY: 'librarr-key',
          GATEWAY_DB_PATH: ':memory:',
          STAGING_ROOT: stagingDir,
          LIBRARY_MAPPINGS_JSON: JSON.stringify({ lib1: path.join(stagingDir, '..', 'lib1') })
        })
        let browseStarted = false
        app = buildApp({
          config,
          fetcher: (async () => json({ id: 'u1', isActive: true, librariesAccessible: ['lib1'] })) as unknown as typeof fetch,
          librarrFetcher: ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            if (String(input).includes('/api/downloads')) return Promise.resolve(json({ downloads: [] }))
            browseStarted = true
            return new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
            })
          }) as unknown as typeof fetch,
          logger: false
        })
        await app.ready()

        // Only the timers used by the Librarr client's deadline are faked.
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        const pending = get('/discover/browse?catalog=popular')
        for (let i = 0; i < 200 && !browseStarted; i += 1) await new Promise((resolve) => setImmediate(resolve))
        expect(browseStarted).toBe(true)
        await vi.advanceTimersByTimeAsync(19_999)
        await vi.advanceTimersByTimeAsync(1)
        const response = await pending

        expect(response.statusCode).toBe(504)
        expect(response.json()).toMatchObject({ code: 'librarr_timeout', retryable: true })
      })
    })

    it('maps an unparseable Librarr body to a 502 discover_bad_response', async () => {
      librarrReply = () => json({ status: 'surprise', items: [] })
      const response = await get('/discover/browse?catalog=popular')
      expect(response.statusCode).toBe(502)
      expect(response.json()).toMatchObject({ code: 'discover_bad_response', retryable: false })
    })

    describe('query validation', () => {
      it.each([
        ['offset past the maximum', '/discover/browse?catalog=popular&offset=999'],
        ['offset not a multiple of 20', '/discover/browse?catalog=popular&offset=7'],
        ['a blank offset (not silently 0)', '/discover/browse?catalog=popular&offset='],
        ['a negative offset', '/discover/browse?catalog=popular&offset=-20'],
        ['a non-numeric offset', '/discover/browse?catalog=popular&offset=abc'],
        // Decimal digits only. Numeric coercion alone would read all three of these as a valid
        // page boundary -- `0x14` and `2e1` as 20, and whitespace as 0.
        ['a hex offset that coerces to 20', '/discover/browse?catalog=popular&offset=0x14'],
        ['an exponent offset that coerces to 20', '/discover/browse?catalog=popular&offset=2e1'],
        ['a whitespace offset that coerces to 0', '/discover/browse?catalog=popular&offset=%20'],
        ['a signed offset', '/discover/browse?catalog=popular&offset=%2B20'],
        ['a missing catalog', '/discover/browse'],
        ['a blank catalog', '/discover/browse?catalog=']
      ])('returns 400 invalid_query for %s', async (_name, url) => {
        const response = await get(url)
        expect(response.statusCode).toBe(400)
        expect(response.json()).toMatchObject({ code: 'invalid_query', retryable: false })
        // A rejected query never reaches Librarr.
        expect(discoverUrls()).toHaveLength(0)
      })

      it('accepts the maximum offset and defaults an omitted offset to 0', async () => {
        librarrReply = () => json({ ...browseFixture, offset: 180, next_offset: null })
        const last = await get('/discover/browse?catalog=popular&offset=180')
        expect(last.statusCode).toBe(200)
        expect(last.json().offset).toBe(180)

        librarrReply = () => json(browseFixture)
        const first = await get('/discover/browse?catalog=popular')
        expect(first.json().offset).toBe(0)
      })
    })

    describe('cursor validation', () => {
      const withNext = (next: unknown, offset = 0) => {
        librarrReply = () => json({ ...browseFixture, offset, next_offset: next })
        return get(`/discover/browse?catalog=popular&offset=${offset}`)
      }

      it('passes a forward page boundary through', async () => {
        expect((await withNext(20)).json().nextOffset).toBe(20)
        expect((await withNext(180, 160)).json().nextOffset).toBe(180)
      })

      it('turns a next_offset that does not advance into the last page', async () => {
        expect((await withNext(0)).json().nextOffset).toBeNull()
        expect((await withNext(20, 20)).json().nextOffset).toBeNull()
        expect((await withNext(20, 40)).json().nextOffset).toBeNull()
      })

      it('turns a next_offset that is not a page boundary or is out of range into the last page', async () => {
        expect((await withNext(25)).json().nextOffset).toBeNull()
        expect((await withNext(200, 180)).json().nextOffset).toBeNull()
        expect((await withNext(300)).json().nextOffset).toBeNull()
      })

      it('yields null at offset 180 even when Librarr offers a cursor', async () => {
        const response = await withNext(200, 180)
        expect(response.statusCode).toBe(200)
        expect(response.json().nextOffset).toBeNull()
      })

      it('treats a missing next_offset as the last page', async () => {
        librarrReply = () => {
          const { next_offset: _dropped, ...rest } = browseFixture
          return json(rest)
        }
        expect((await get('/discover/browse?catalog=popular')).json().nextOffset).toBeNull()
      })
    })
  })
})
