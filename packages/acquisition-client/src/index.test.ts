import { describe, expect, it, vi } from 'vitest'
import {
  AcquisitionApiError,
  AcquisitionTimeoutError,
  BROWSE_TIMEOUT_MS,
  createAcquisitionClient,
  DEFAULT_TIMEOUT_MS,
  SEARCH_TIMEOUT_MS
} from './index'

/** A fetcher that never answers, but rejects the way a real one does when its signal aborts --
 * including the already-aborted case, which real `fetch` rejects immediately and an
 * `addEventListener`-only fake would miss. */
function hangingFetcher() {
  return vi.fn(
    (_url: URL | RequestInfo, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const fail = () => reject(new DOMException('Aborted', 'AbortError'))
        if (init?.signal?.aborted) fail()
        else init?.signal?.addEventListener('abort', fail)
      })
  )
}

function client(overrides: Partial<Parameters<typeof createAcquisitionClient>[0]> = {}) {
  return createAcquisitionClient({ baseUrl: 'https://books.test/acquisition-api/v1', ...overrides })
}

describe('acquisition client', () => {
  it('sends bearer auth and parses status', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          version: '1.0.0',
          ready: true,
          librarr: { reachable: true },
          staging: { ready: true },
          libraries: [{ id: 'lib1', enabled: true }]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    )
    const client = createAcquisitionClient({
      baseUrl: 'https://books.test/acquisition-api/v1',
      getAccessToken: async () => 'token',
      fetcher
    })
    await expect(client.status()).resolves.toMatchObject({ ready: true })
    expect(fetcher).toHaveBeenCalledWith(
      'https://books.test/acquisition-api/v1/status',
      expect.objectContaining({
        headers: expect.any(Headers),
        credentials: 'include'
      })
    )
    expect((fetcher.mock.calls[0][1].headers as Headers).get('authorization')).toBe('Bearer token')
  })

  // An origin that serves the ABS app but does not route the gateway answers 404 with an HTML
  // error page. `response.json()` threw a SyntaxError on that body, which carried no status, so
  // the one error callers most need to distinguish was indistinguishable from a bug.
  it('keeps the status code when the error body is not JSON', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('<html>Cannot GET /acquisition-api/v1/status</html>', { status: 404, headers: { 'content-type': 'text/html' } }))
    const error = await client({ fetcher }).status().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AcquisitionApiError)
    expect((error as AcquisitionApiError).status).toBe(404)
    expect((error as AcquisitionApiError).code).toBe('gateway_error')
  })

  it('rejects a 200 with a non-JSON body rather than returning garbage', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('<html>hello</html>', { status: 200, headers: { 'content-type': 'text/html' } }))
    await expect(client({ fetcher }).status()).rejects.toBeInstanceOf(AcquisitionApiError)
  })

  it('times out a request that never answers', async () => {
    const fetcher = hangingFetcher()
    await expect(client({ fetcher, timeoutMs: 20 }).status()).rejects.toBeInstanceOf(AcquisitionTimeoutError)
  })

  it('gives search its own, longer budget', async () => {
    const fetcher = hangingFetcher()
    // 20ms search budget against a default that would otherwise apply: proves the search path
    // reads searchTimeoutMs, not timeoutMs.
    await expect(client({ fetcher, timeoutMs: 10_000, searchTimeoutMs: 20 }).searchAudiobooks('lib1', 'dune')).rejects.toBeInstanceOf(AcquisitionTimeoutError)
    expect(SEARCH_TIMEOUT_MS).toBeGreaterThan(DEFAULT_TIMEOUT_MS)
  })

  describe('discover', () => {
    const browseBody = { status: 'ok', catalog: 'popular', genre: '', offset: 0, nextOffset: 20, partial: false, items: [] }
    const okFetcher = (body: unknown = browseBody) =>
      vi.fn().mockImplementation(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }))
    const calledUrl = (fetcher: ReturnType<typeof vi.fn>) => new URL(String(fetcher.mock.calls[0][0]))

    it('builds the browse query, encoding a genre with a space and one with an apostrophe', async () => {
      const spaced = okFetcher()
      await client({ fetcher: spaced }).browseDiscover({ catalog: 'popular', genre: 'science fiction', offset: 20 })
      expect(String(spaced.mock.calls[0][0])).toContain('/discover/browse?')
      expect(calledUrl(spaced).searchParams.get('genre')).toBe('science fiction')
      expect(calledUrl(spaced).searchParams.get('catalog')).toBe('popular')
      expect(calledUrl(spaced).searchParams.get('offset')).toBe('20')
      // No raw space may reach the wire.
      expect(String(spaced.mock.calls[0][0])).not.toContain(' ')

      const apostrophe = okFetcher()
      await client({ fetcher: apostrophe }).browseDiscover({ catalog: 'new', genre: "children's" })
      expect(calledUrl(apostrophe).searchParams.get('genre')).toBe("children's")
      expect(calledUrl(apostrophe).searchParams.has('offset')).toBe(false)
    })

    it('omits genre when absent or empty, and still sends offset 0 when given', async () => {
      const none = okFetcher()
      await client({ fetcher: none }).browseDiscover({ catalog: 'popular', offset: 0 })
      expect(String(none.mock.calls[0][0])).not.toContain('genre')
      expect(calledUrl(none).searchParams.get('offset')).toBe('0')

      const empty = okFetcher()
      await client({ fetcher: empty }).browseDiscover({ catalog: 'popular', genre: '' })
      expect(String(empty.mock.calls[0][0])).not.toContain('genre')
    })

    it('sends the bearer token and returns the parsed body, for both discover calls', async () => {
      const fetcher = okFetcher()
      const c = client({ fetcher, getAccessToken: async () => 'token' })
      await expect(c.browseDiscover({ catalog: 'popular' })).resolves.toMatchObject({ status: 'ok', nextOffset: 20 })
      await expect(c.getDiscoverOptions()).resolves.toBeDefined()
      expect(String(fetcher.mock.calls[1][0])).toBe('https://books.test/acquisition-api/v1/discover/options')
      for (const call of fetcher.mock.calls) {
        expect((call[1].headers as Headers).get('authorization')).toBe('Bearer token')
      }
    })

    it('surfaces the gateway error code and status for a 502', async () => {
      const fetcher = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ code: 'discover_upstream_unavailable', message: 'Open Library is unavailable', retryable: true }), { status: 502 })
      )
      const error = await client({ fetcher }).browseDiscover({ catalog: 'popular' }).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(AcquisitionApiError)
      expect(error).toMatchObject({ status: 502, code: 'discover_upstream_unavailable' })
    })

    it('honours browseTimeoutMs and reports a deadline as AcquisitionTimeoutError', async () => {
      // 20ms browse budget against a 10s default: proves browse reads browseTimeoutMs.
      await expect(client({ fetcher: hangingFetcher(), timeoutMs: 10_000, browseTimeoutMs: 20 }).browseDiscover({ catalog: 'popular' })).rejects.toBeInstanceOf(
        AcquisitionTimeoutError
      )
    })

    it('defaults browse to a 45s budget, longer than the general one', () => {
      expect(BROWSE_TIMEOUT_MS).toBe(45_000)
      expect(BROWSE_TIMEOUT_MS).toBeGreaterThan(DEFAULT_TIMEOUT_MS)
    })

    it('lets a per-call timeout override the browse budget', async () => {
      await expect(client({ fetcher: hangingFetcher(), browseTimeoutMs: 10_000 }).browseDiscover({ catalog: 'popular' }, { timeoutMs: 20 })).rejects.toBeInstanceOf(
        AcquisitionTimeoutError
      )
    })

    it('aborts on the caller signal with an AbortError, not a timeout', async () => {
      const controller = new AbortController()
      const pending = client({ fetcher: hangingFetcher() }).browseDiscover({ catalog: 'popular' }, { signal: controller.signal })
      controller.abort()
      const error = await pending.catch((e: unknown) => e)
      expect(error).not.toBeInstanceOf(AcquisitionTimeoutError)
      expect((error as DOMException).name).toBe('AbortError')
    })

    it('aborts getDiscoverOptions on the caller signal too', async () => {
      const controller = new AbortController()
      controller.abort()
      const error = await client({ fetcher: hangingFetcher() }).getDiscoverOptions({ signal: controller.signal }).catch((e: unknown) => e)
      expect((error as DOMException).name).toBe('AbortError')
    })
  })

  // A user-driven cancel must not be reported as a timeout -- the UI says different things.
  it('propagates a caller abort as an AbortError, not a timeout', async () => {
    const fetcher = hangingFetcher()
    const controller = new AbortController()
    const pending = client({ fetcher, timeoutMs: 10_000 }).searchAudiobooks('lib1', 'dune', { signal: controller.signal })
    controller.abort()
    const error = await pending.catch((e: unknown) => e)
    expect(error).not.toBeInstanceOf(AcquisitionTimeoutError)
    expect((error as DOMException).name).toBe('AbortError')
  })
})
