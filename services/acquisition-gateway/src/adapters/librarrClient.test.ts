import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { LIBRARR_BROWSE_TIMEOUT_MS, LibrarrApiError, LibrarrClient, LibrarrTimeoutError } from './librarrClient'

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures', 'librarr')
const searchFixture = JSON.parse(readFileSync(path.join(FIXTURES, 'search-audiobooks.json'), 'utf-8'))
const downloadsFixture = JSON.parse(readFileSync(path.join(FIXTURES, 'downloads.json'), 'utf-8'))

function fixtureFetch(expectedPathIncludes: string, body: unknown, status = 200): typeof fetch {
  return vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input)
    if (!url.includes(expectedPathIncludes)) {
      throw new Error(`unexpected URL ${url}, expected to include ${expectedPathIncludes}`)
    }
    void init
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
}

describe('LibrarrClient', () => {
  it('authenticates search and preserves the exact raw results for server-side submission', async () => {
    const fetcher = fixtureFetch('/api/search/audiobooks', searchFixture)
    const client = new LibrarrClient({ baseUrl: 'http://librarr:5050', apiKey: 'secret', fetcher })
    const results = await client.searchAudiobooks('Project Hail Mary')

    expect(results).toHaveLength(3)
    expect(results[0].info_hash).toBe('0123456789abcdef0123456789abcdef01234567')
    // AudioBookBay result carries only abb_url -- no info_hash/magnet at search time, and
    // (WI-1496 t1050, confirmed live) no media_type either: internal/models/book.go's
    // MediaType field is `json:"media_type,omitempty"` and AudioBookBay's own Search()
    // never sets it, unlike other sources -- a schema that required the literal 'audiobook'
    // here rejected every real AudioBookBay result.
    expect(results[1].abb_url).toBe('/audio-books/project-hail-mary-by-andy-weir/')
    expect(results[1].info_hash).toBeUndefined()
    expect(results[1].magnet_url).toBeUndefined()
    expect(results[1].media_type).toBeUndefined()
    // NZB result is protocol-tagged.
    expect(results[2].download_protocol).toBe('nzb')

    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining('q=Project+Hail+Mary'),
      expect.objectContaining({ headers: expect.any(Headers) })
    )
    const [, init] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0]
    expect((init.headers as Headers).get('x-api-key')).toBe('secret')
  })

  it('submits the exact raw snapshot entry byte-for-byte as the download request body', async () => {
    let capturedBody: string | undefined
    const fetcher = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      capturedBody = init?.body as string
      return new Response(JSON.stringify({ success: true, title: 'Project Hail Mary', hash: 'abc123' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }) as unknown as typeof fetch
    const client = new LibrarrClient({ baseUrl: 'http://librarr:5050', apiKey: 'secret', fetcher })
    const raw = searchFixture.results[0]

    const response = await client.submitAudiobook(raw)

    expect(JSON.parse(capturedBody!)).toEqual(raw)
    expect(response).toMatchObject({ success: true, hash: 'abc123' })
  })

  it('parses the downloads queue, including hash and job_id correlation fields', async () => {
    const fetcher = fixtureFetch('/api/downloads', downloadsFixture)
    const client = new LibrarrClient({ baseUrl: 'http://librarr:5050', apiKey: 'secret', fetcher })
    const downloads = await client.getDownloads()
    expect(downloads).toHaveLength(2)
    expect(downloads[0].hash).toBe('0123456789abcdef0123456789abcdef01234567')
    expect(downloads[1].job_id).toBe('job-abc123')
  })

  it('classifies the SABnzbd-not-configured 400 as a stable non-retryable code', async () => {
    const fetcher = fixtureFetch('/api/download/audiobook', { success: false, error: 'SABnzbd not configured' }, 400)
    const client = new LibrarrClient({ baseUrl: 'http://librarr:5050', apiKey: 'secret', fetcher })
    const raw = searchFixture.results[2]

    await expect(client.submitAudiobook(raw)).rejects.toMatchObject({
      code: 'sabnzbd_not_configured',
      status: 400
    })
  })

  it('sanitizes a generic non-2xx response into a LibrarrApiError', async () => {
    const fetcher = fixtureFetch('/api/download/audiobook', { success: false, error: 'boom' }, 500)
    const client = new LibrarrClient({ baseUrl: 'http://librarr:5050', apiKey: 'secret', fetcher })
    await expect(client.submitAudiobook(searchFixture.results[0])).rejects.toBeInstanceOf(LibrarrApiError)
  })

  it('reports health true only when Librarr returns status "ok"', async () => {
    const ok = new LibrarrClient({
      baseUrl: 'http://librarr:5050',
      apiKey: 'secret',
      fetcher: fixtureFetch('/api/health', { status: 'ok' })
    })
    await expect(ok.health()).resolves.toBe(true)

    const down = new LibrarrClient({
      baseUrl: 'http://librarr:5050',
      apiKey: 'secret',
      fetcher: (async () => {
        throw new Error('network down')
      }) as unknown as typeof fetch
    })
    await expect(down.health()).resolves.toBe(false)
  })

  describe('discover', () => {
    const optionsFixture = JSON.parse(readFileSync(path.join(FIXTURES, 'discover-options.json'), 'utf-8'))
    const browseFixture = JSON.parse(readFileSync(path.join(FIXTURES, 'discover-browse.json'), 'utf-8'))
    const outageFixture = JSON.parse(readFileSync(path.join(FIXTURES, 'discover-browse-upstream-unavailable.json'), 'utf-8'))
    const make = (fetcher: typeof fetch, extra: { browseTimeoutMs?: number } = {}) =>
      new LibrarrClient({ baseUrl: 'http://librarr:5050', apiKey: 'secret', fetcher, ...extra })
    const lastUrl = (fetcher: typeof fetch) => new URL(String((fetcher as ReturnType<typeof vi.fn>).mock.calls[0][0]))

    it('parses the options and sends the api key', async () => {
      const fetcher = fixtureFetch('/api/discover/options', optionsFixture)
      const options = await make(fetcher).getDiscoverOptions()

      expect(options.catalogs.map((c) => c.id)).toEqual(['popular', 'new', 'top_rated'])
      expect(options.genres).toContainEqual({ id: "children's", label: "Children's" })
      expect(options.genres).toContainEqual({ id: 'science fiction', label: 'Science fiction' })
      const [, init] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0]
      expect((init.headers as Headers).get('x-api-key')).toBe('secret')
    })

    it('maps a browse success from snake_case to camelCase and normalises cover and year', async () => {
      const fetcher = fixtureFetch('/api/discover/browse', browseFixture)
      const page = await make(fetcher).browseDiscover('popular', undefined, 0)

      expect(page).toMatchObject({ status: 'ok', catalog: 'popular', genre: '', offset: 0, nextOffset: 20, partial: false })
      expect(page.items[0]).toEqual({
        key: '/works/OL17930368W',
        title: 'Atomic Habits',
        author: 'James Clear',
        coverUrl: 'https://covers.openlibrary.org/b/id/12539702-M.jpg',
        year: 2016,
        popularity: 66698
      })
      // cover_url "" -> null, year 0 -> null
      expect(page.items[1]).toMatchObject({ coverUrl: null, year: null })
      const [, init] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0]
      expect((init.headers as Headers).get('x-api-key')).toBe('secret')
    })

    it('parses the outage body, which has no echoed query fields, without throwing', async () => {
      const fetcher = fixtureFetch('/api/discover/browse', outageFixture)
      const page = await make(fetcher).browseDiscover('popular', undefined, 0)

      expect(page).toMatchObject({
        status: 'upstream_unavailable',
        error: 'Open Library is unavailable',
        nextOffset: null,
        items: [],
        catalog: undefined,
        genre: undefined,
        offset: undefined
      })
    })

    it('parses a failure body whose items is null and whose next_offset is null', async () => {
      const body = { status: 'rate_limited', error: 'slow down', catalog: 'popular', genre: '', offset: 0, next_offset: null, partial: false, items: null }
      const page = await make(fixtureFetch('/api/discover/browse', body)).browseDiscover('popular', undefined, 0)
      expect(page).toMatchObject({ status: 'rate_limited', nextOffset: null, items: [] })
    })

    it('rejects an ok body that has no items array rather than showing an empty shelf', async () => {
      const body = { status: 'ok', error: '', catalog: 'popular', genre: '', offset: 0, next_offset: null, partial: false }
      await expect(make(fixtureFetch('/api/discover/browse', body)).browseDiscover('popular', undefined, 0)).rejects.toThrow()
    })

    it('surfaces Retry-After from the response headers', async () => {
      const fetcher = vi.fn(
        async () =>
          new Response(JSON.stringify({ status: 'rate_limited', error: 'slow down', items: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json', 'retry-after': '30' }
          })
      ) as unknown as typeof fetch
      const page = await make(fetcher).browseDiscover('popular', undefined, 0)
      expect(page.retryAfter).toBe('30')
    })

    it('keeps an ok page with a short item list and a non-null next_offset (a short page is not the last)', async () => {
      const body = { ...browseFixture, genre: 'science fiction', items: browseFixture.items.slice(0, 1), next_offset: 20 }
      const page = await make(fixtureFetch('/api/discover/browse', body)).browseDiscover('popular', 'science fiction', 0)
      expect(page.items).toHaveLength(1)
      expect(page.nextOffset).toBe(20)
    })

    it('omits genre from the query when it is empty or undefined, and encodes it when present', async () => {
      const none = fixtureFetch('/api/discover/browse', browseFixture)
      await make(none).browseDiscover('popular', undefined, 0)
      expect(lastUrl(none).searchParams.has('genre')).toBe(false)
      expect(String((none as ReturnType<typeof vi.fn>).mock.calls[0][0])).not.toContain('genre=')

      const blank = fixtureFetch('/api/discover/browse', browseFixture)
      await make(blank).browseDiscover('popular', '', 0)
      expect(String((blank as ReturnType<typeof vi.fn>).mock.calls[0][0])).not.toContain('genre')

      const some = fixtureFetch('/api/discover/browse', browseFixture)
      await make(some).browseDiscover('new', "children's", 40)
      const url = lastUrl(some)
      expect(url.searchParams.get('catalog')).toBe('new')
      expect(url.searchParams.get('genre')).toBe("children's")
      expect(url.searchParams.get('offset')).toBe('40')
    })

    it('surfaces an old Librarr 404 as a LibrarrApiError with status 404', async () => {
      const fetcher = fixtureFetch('/api/discover/browse', { error: 'not found' }, 404)
      await expect(make(fetcher).browseDiscover('popular', undefined, 0)).rejects.toMatchObject({ status: 404 })
    })

    it('throws LibrarrTimeoutError for a slow browse, using its own budget rather than the 5s default', async () => {
      const hanging = vi.fn(
        (_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
          })
      ) as unknown as typeof fetch
      const error = await make(hanging, { browseTimeoutMs: 20 }).browseDiscover('popular', undefined, 0).catch((e) => e)
      expect(error).toBeInstanceOf(LibrarrTimeoutError)
      expect(error).toMatchObject({ code: 'librarr_timeout', timeoutMs: 20 })
    })

    it('surfaces a transport-level 429 as a LibrarrApiError with status 429', async () => {
      const fetcher = fixtureFetch('/api/discover/browse', { error: 'slow down' }, 429)
      await expect(make(fetcher).browseDiscover('popular', undefined, 0)).rejects.toMatchObject({ status: 429, code: 'librarr_error' })
    })

    it('aborts the Librarr request with an AbortError when the caller signal fires, not a timeout or TypeError', async () => {
      let seen: AbortSignal | undefined
      const hanging = vi.fn(
        (_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            seen = init?.signal ?? undefined
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
          })
      ) as unknown as typeof fetch
      const caller = new AbortController()
      const pending = make(hanging).browseDiscover('popular', undefined, 0, caller.signal).catch((e) => e)
      expect(seen?.aborted).toBe(false)
      caller.abort()
      const error = await pending
      expect(seen?.aborted).toBe(true)
      expect(error).toBeInstanceOf(DOMException)
      expect(error).toMatchObject({ name: 'AbortError' })
      expect(error).not.toBeInstanceOf(LibrarrTimeoutError)
      expect(error).not.toBeInstanceOf(TypeError)
    })

    it('treats a caller abort during the body read as an abort, not a bad response', async () => {
      const caller = new AbortController()
      const fetcher = vi.fn(async () => {
        const response = new Response('{', { status: 200, headers: { 'content-type': 'application/json' } })
        caller.abort()
        return response
      }) as unknown as typeof fetch
      const error = await make(fetcher).browseDiscover('popular', undefined, 0, caller.signal).catch((e) => e)
      expect(error).toMatchObject({ name: 'AbortError' })
    })

    it('defaults the browse budget to 20s, past the 5s default and Librarr’s own 15s ceiling', async () => {
      expect(LIBRARR_BROWSE_TIMEOUT_MS).toBe(20_000)
      vi.useFakeTimers()
      try {
        const hanging = vi.fn(
          (_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
            })
        ) as unknown as typeof fetch
        const pending = make(hanging).browseDiscover('popular', undefined, 0).catch((e) => e)
        await vi.advanceTimersByTimeAsync(19_999)
        expect(await Promise.race([pending, 'pending'])).toBe('pending')
        await vi.advanceTimersByTimeAsync(1)
        expect(await pending).toMatchObject({ code: 'librarr_timeout', timeoutMs: 20_000 })
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('deadlines', () => {
    /** A Librarr that accepts the request and never answers; only the abort signal ends it. */
    function hangingFetch(): typeof fetch {
      return vi.fn(
        (_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            )
          })
      ) as unknown as typeof fetch
    }

    it('fails a hung search with a distinguishable timeout error instead of hanging', async () => {
      const client = new LibrarrClient({
        baseUrl: 'http://librarr:5050',
        apiKey: 'secret',
        fetcher: hangingFetch(),
        searchTimeoutMs: 20
      })
      const error = await client.searchAudiobooks('Dune').catch((e) => e)

      expect(error).toBeInstanceOf(LibrarrTimeoutError)
      expect(error).toBeInstanceOf(LibrarrApiError)
      expect(error).toMatchObject({ code: 'librarr_timeout', status: 504, timeoutMs: 20 })
      // The user's search text must not leak into the error message.
      expect(error.message).not.toContain('Dune')
      expect(error.message).toContain('/api/search/audiobooks')
    })

    it('gives other calls their own, shorter budget', async () => {
      const client = new LibrarrClient({
        baseUrl: 'http://librarr:5050',
        apiKey: 'secret',
        fetcher: hangingFetch(),
        searchTimeoutMs: 60_000,
        timeoutMs: 20
      })
      await expect(client.getDownloads()).rejects.toMatchObject({ code: 'librarr_timeout', timeoutMs: 20 })
    })

    it('defaults to a 10s search budget and a 5s budget for everything else', async () => {
      vi.useFakeTimers()
      try {
        const client = new LibrarrClient({ baseUrl: 'http://librarr:5050', apiKey: 'secret', fetcher: hangingFetch() })

        const search = client.searchAudiobooks('Dune').catch((e) => e)
        const downloads = client.getDownloads().catch((e) => e)

        await vi.advanceTimersByTimeAsync(4_999)
        expect(await Promise.race([downloads, 'pending'])).toBe('pending')
        await vi.advanceTimersByTimeAsync(1)
        expect(await downloads).toMatchObject({ code: 'librarr_timeout', timeoutMs: 5_000 })

        await vi.advanceTimersByTimeAsync(4_999)
        expect(await Promise.race([search, 'pending'])).toBe('pending')
        await vi.advanceTimersByTimeAsync(1)
        expect(await search).toMatchObject({ code: 'librarr_timeout', timeoutMs: 10_000 })
      } finally {
        vi.useRealTimers()
      }
    })

    it('does not mistake a slow-but-successful response for a timeout', async () => {
      const fetcher = fixtureFetch('/api/search/audiobooks', searchFixture)
      const client = new LibrarrClient({ baseUrl: 'http://librarr:5050', apiKey: 'secret', fetcher, searchTimeoutMs: 20 })
      await expect(client.searchAudiobooks('Project Hail Mary')).resolves.toHaveLength(3)
    })

    it('keeps a timeout distinct from a Librarr error response', async () => {
      const fetcher = fixtureFetch('/api/download/audiobook', { success: false, error: 'boom' }, 500)
      const client = new LibrarrClient({ baseUrl: 'http://librarr:5050', apiKey: 'secret', fetcher })
      const error = await client.submitAudiobook(searchFixture.results[0]).catch((e) => e)
      expect(error).toBeInstanceOf(LibrarrApiError)
      expect(error).not.toBeInstanceOf(LibrarrTimeoutError)
      expect(error.code).toBe('librarr_error')
    })
  })
})
