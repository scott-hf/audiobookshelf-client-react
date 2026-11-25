import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionStore } from '../auth/session'
import type { SessionVault } from '../auth/vault'
import { AcquisitionApiError, createMobileAcquisitionClient, formatAcquisitionError } from './acquisitionClient'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const loginResponse = { user: { id: 'u1', accessToken: 'access-1', refreshToken: 'refresh-1' } }
const refreshResponse = { user: { accessToken: 'new-access', refreshToken: 'new-refresh' } }
const searchResponse = { searchSessionId: 's1', results: [] }

describe('createMobileAcquisitionClient', () => {
  let vault: SessionVault
  let fetcher: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vault = {
      read: vi.fn().mockResolvedValue(null),
      write: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined)
    }
    fetcher = vi.fn()
  })

  it('uses the ABS bearer access token for gateway calls', async () => {
    fetcher.mockResolvedValueOnce(json(loginResponse)).mockResolvedValueOnce(json(searchResponse))
    const session = new SessionStore({ vault, fetcher: fetcher as unknown as typeof fetch })
    await session.login('https://books.test', 'scott', 'password')

    const client = createMobileAcquisitionClient(session, fetcher as unknown as typeof fetch)
    await expect(client.searchAudiobooks('lib1', 'Project Hail Mary')).resolves.toEqual(searchResponse)

    const [url, init] = fetcher.mock.calls[1] as [string, RequestInit]
    expect(url).toContain('/acquisition-api/v1/search/audiobooks')
    expect((init.headers as Headers).get('authorization')).toBe('Bearer access-1')
  })

  it('refreshes once and retries after a 401, mirroring the ABS client', async () => {
    fetcher
      .mockResolvedValueOnce(json(loginResponse))
      .mockResolvedValueOnce(json({ code: 'unauthorized', message: 'expired' }, 401))
      .mockResolvedValueOnce(json(refreshResponse))
      .mockResolvedValueOnce(json(searchResponse))

    const session = new SessionStore({ vault, fetcher: fetcher as unknown as typeof fetch })
    await session.login('https://books.test', 'scott', 'password')

    const client = createMobileAcquisitionClient(session, fetcher as unknown as typeof fetch)
    await expect(client.searchAudiobooks('lib1', 'q')).resolves.toEqual(searchResponse)
    expect(fetcher).toHaveBeenCalledTimes(4)
  })

  describe('discover calls', () => {
    const browseResponse = { status: 'ok', catalog: 'popular', genre: '', offset: 0, nextOffset: null, partial: false, items: [] }
    const optionsResponse = { catalogs: [{ id: 'popular', label: 'Popular' }], genres: [] }
    const unauthorized = () => json({ code: 'unauthorized', message: 'expired' }, 401)

    async function authed() {
      fetcher.mockResolvedValueOnce(json(loginResponse))
      const session = new SessionStore({ vault, fetcher: fetcher as unknown as typeof fetch })
      await session.login('https://books.test', 'scott', 'password')
      return createMobileAcquisitionClient(session, fetcher as unknown as typeof fetch)
    }

    /** A fetch that never answers and rejects like the real one when its signal aborts. */
    const hang = (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const fail = () => reject(new DOMException('Aborted', 'AbortError'))
        if (init?.signal?.aborted) fail()
        else init?.signal?.addEventListener('abort', fail)
      })

    it('browseDiscover retries once after a 401 + refresh and uses the new token', async () => {
      const client = await authed()
      fetcher.mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(json(refreshResponse)).mockResolvedValueOnce(json(browseResponse))

      await expect(client.browseDiscover({ catalog: 'popular', genre: 'science fiction' })).resolves.toEqual(browseResponse)

      expect(fetcher).toHaveBeenCalledTimes(4)
      const [url, init] = fetcher.mock.calls[3] as [string, RequestInit]
      expect(url).toContain('/acquisition-api/v1/discover/browse?')
      expect(url).toContain('genre=science+fiction')
      expect((init.headers as Headers).get('authorization')).toBe('Bearer new-access')
    })

    it('getDiscoverOptions retries once after a 401 + refresh', async () => {
      const client = await authed()
      fetcher.mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(json(refreshResponse)).mockResolvedValueOnce(json(optionsResponse))

      await expect(client.getDiscoverOptions()).resolves.toEqual(optionsResponse)
      expect(fetcher).toHaveBeenCalledTimes(4)
      expect(fetcher.mock.calls[3][0]).toContain('/acquisition-api/v1/discover/options')
    })

    it('does not retry a second time when the retry is also a 401', async () => {
      const client = await authed()
      fetcher.mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(json(refreshResponse)).mockResolvedValueOnce(unauthorized())
      await expect(client.browseDiscover({ catalog: 'popular' })).rejects.toMatchObject({ status: 401 })
      expect(fetcher).toHaveBeenCalledTimes(4)
    })

    it('keeps the abort signal on the retry after a 401 + refresh (browseDiscover)', async () => {
      const client = await authed()
      const controller = new AbortController()
      fetcher.mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(json(refreshResponse)).mockImplementationOnce(hang)

      const pending = client.browseDiscover({ catalog: 'popular' }, { signal: controller.signal }).catch((e: unknown) => e)
      // Let the 401, the refresh and the retry's fetch all start before aborting.
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(4))
      controller.abort()

      const error = await pending
      expect((error as DOMException).name).toBe('AbortError')
    })

    it('keeps the abort signal on the retry after a 401 + refresh (getDiscoverOptions)', async () => {
      const client = await authed()
      const controller = new AbortController()
      fetcher.mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(json(refreshResponse)).mockImplementationOnce(hang)

      const pending = client.getDiscoverOptions({ signal: controller.signal }).catch((e: unknown) => e)
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(4))
      controller.abort()

      expect(((await pending) as DOMException).name).toBe('AbortError')
    })

    it('rejects the retry immediately when the signal was aborted while the refresh was in flight', async () => {
      const client = await authed()
      const controller = new AbortController()
      fetcher
        .mockResolvedValueOnce(unauthorized())
        .mockImplementationOnce(async () => {
          // The user changes selection while the token refresh is still running.
          controller.abort()
          return json(refreshResponse)
        })
        .mockImplementationOnce(hang)

      const error = await client.browseDiscover({ catalog: 'popular' }, { signal: controller.signal }).catch((e: unknown) => e)
      expect((error as DOMException).name).toBe('AbortError')
    })
  })

  it('throws when constructed without an authenticated session', () => {
    const session = new SessionStore({ vault, fetcher: fetcher as unknown as typeof fetch })
    expect(() => createMobileAcquisitionClient(session)).toThrow()
  })
})

describe('formatAcquisitionError', () => {
  it('maps known gateway error codes to stable copy', () => {
    expect(formatAcquisitionError(new AcquisitionApiError(404, 'release_not_found', 'nope'))).toBe('That release could not be found.')
  })

  it('maps the discover codes to their copy, before any generic status message', () => {
    expect(formatAcquisitionError(new AcquisitionApiError(502, 'discover_upstream_unavailable', 'x'))).toBe(
      'Open Library is temporarily unavailable. Search still works.'
    )
    expect(formatAcquisitionError(new AcquisitionApiError(429, 'discover_rate_limited', 'x'))).toBe(
      'Too many requests to Open Library. Try again in a minute.'
    )
    // A 404 must not fall through to "the acquisition service is not available on this server".
    expect(formatAcquisitionError(new AcquisitionApiError(404, 'discover_not_supported', 'x'))).toBe(
      'Book suggestions are not available on this server.'
    )
  })

  it('maps discover_bad_response to readable copy, never the raw code', () => {
    const text = formatAcquisitionError(new AcquisitionApiError(502, 'discover_bad_response', 'x'))
    expect(text).toBe('Book suggestions could not be loaded.')
    expect(text).not.toContain('discover_bad_response')
  })

  it.each([
    [504, 'librarr_timeout', 'The server took too long to answer. Try again.'],
    [502, 'librarr_unreachable', 'The server could not reach a service it depends on. Try again in a moment.'],
    [502, 'librarr_error', 'The server could not complete that request. Try again.']
  ])('maps the shared %i %s code to copy that blames no feature or component', (status, code, expected) => {
    const text = formatAcquisitionError(new AcquisitionApiError(status, code, 'x'))
    expect(text).toBe(expected)
    expect(text).not.toMatch(/librarr|open library|suggestion|\(\d{3}\)/i)
  })

  it('still reports a code-less 404 as the service being unavailable', () => {
    expect(formatAcquisitionError(new AcquisitionApiError(404, 'gateway_error', 'x'))).toBe('The acquisition service is not available on this server.')
  })

  it('falls back to a generic message for unknown errors', () => {
    expect(formatAcquisitionError(new Error('boom'))).toBe('Something went wrong. Please try again.')
  })
})
