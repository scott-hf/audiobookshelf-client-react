import { describe, expect, it, vi } from 'vitest'
import { AcquisitionApiError, AcquisitionTimeoutError, createAcquisitionClient, DEFAULT_TIMEOUT_MS, SEARCH_TIMEOUT_MS } from './index'

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
