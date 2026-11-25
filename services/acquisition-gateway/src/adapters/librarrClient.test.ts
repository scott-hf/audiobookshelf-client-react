import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { LibrarrApiError, LibrarrClient, LibrarrTimeoutError } from './librarrClient'

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
