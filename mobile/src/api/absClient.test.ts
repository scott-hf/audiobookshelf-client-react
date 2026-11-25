import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionStore } from '../auth/session'
import { authorFilter, genreFilter, progressFilter } from '../lib/filterUtils'
import { AbsApiError, buildLibraryItemsQuery, createAbsClient, DEFAULT_LIBRARY_PAGE_SIZE, REQUEST_TIMEOUT_MS, SESSION_START_TIMEOUT_MS } from './absClient'
import { buildProgressMap, getProgress } from './progressMap'

const session = {
  getServerUrl: () => 'https://books.test',
  getAccessToken: () => 'token',
  refresh: vi.fn().mockResolvedValue(false)
} as unknown as SessionStore

/** A fetch that never answers on its own and rejects the way a real one does when aborted. */
function hangingFetch() {
  return vi.fn((_url: unknown, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new DOMException('aborted', 'AbortError')))
    })
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createAbsClient request timeout', () => {
  it('aborts a hung request with a typed timeout error instead of waiting forever', async () => {
    const timeout = new AbortController()
    const spy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
    const fetcher = hangingFetch()
    const client = createAbsClient({ session, fetcher: fetcher as unknown as typeof fetch })

    const pending = client.getLibraries()
    timeout.abort(new DOMException('timed out', 'TimeoutError'))

    await expect(pending).rejects.toBeInstanceOf(AbsApiError)
    await expect(pending).rejects.toMatchObject({ status: 408 })
    expect(spy).toHaveBeenCalledWith(REQUEST_TIMEOUT_MS)
    expect(fetcher.mock.calls[0][1]?.signal).toBe(timeout.signal)
  })

  it('gives startSession a longer timeout than ordinary calls', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout')
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 's1', currentTime: 0, audioTracks: [] }), { status: 200 }))
    const client = createAbsClient({ session, fetcher: fetcher as unknown as typeof fetch })

    await client.startSession('b1', {
      deviceInfo: { clientName: 'ShelfDroid', deviceId: 'd' },
      supportedMimeTypes: [],
      mediaPlayer: 'exo',
      forceTranscode: false,
      forceDirectPlay: false
    })

    expect(spy).toHaveBeenCalledWith(SESSION_START_TIMEOUT_MS)
    expect(SESSION_START_TIMEOUT_MS).toBeGreaterThan(REQUEST_TIMEOUT_MS)
  })

  it('does not relabel an ordinary failure as a timeout', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('nope', { status: 500 }))
    const client = createAbsClient({ session, fetcher: fetcher as unknown as typeof fetch })

    await expect(client.getLibraries()).rejects.toMatchObject({ status: 500, message: 'nope' })
  })
})

function jsonFetcher(body: unknown) {
  return vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify(body), { status: 200 })))
}

/** The URL the client asked for, relative to the mocked server. */
function requestedPath(fetcher: ReturnType<typeof vi.fn>, call = 0): string {
  return String(fetcher.mock.calls[call][0]).replace('https://books.test', '')
}

describe('buildLibraryItemsQuery', () => {
  it('defaults to page 0, 48 per page, title ascending, minified', () => {
    expect(buildLibraryItemsQuery()).toBe(`limit=${DEFAULT_LIBRARY_PAGE_SIZE}&page=0&sort=media.metadata.title&minified=1`)
    expect(DEFAULT_LIBRARY_PAGE_SIZE).toBe(48)
  })

  it('carries page, limit, sort and desc', () => {
    expect(buildLibraryItemsQuery({ page: 3, limit: 20, sort: 'addedAt', desc: true, minified: false })).toBe('limit=20&page=3&sort=addedAt&desc=1')
  })

  it('appends an encoded filter verbatim instead of encoding it a second time', () => {
    const filter = genreFilter('Sci-Fi/Fantasy+')
    const query = buildLibraryItemsQuery({ filter })
    expect(query).toContain(`filter=${filter}`)
    // A second encodeURIComponent would turn the "%" of an escaped "=" / "+" into "%25".
    expect(query).not.toContain('%25')
  })

  it('sends collapseseries when there is no filter', () => {
    expect(buildLibraryItemsQuery({ collapseseries: true })).toContain('collapseseries=1')
  })

  it('drops collapseseries whenever a filter is set (2.35.1 bug with the combination)', () => {
    const query = buildLibraryItemsQuery({ collapseseries: true, filter: authorFilter('au_1') })
    expect(query).not.toContain('collapseseries')
    expect(query).toContain('filter=authors.')
  })
})

describe('createAbsClient library endpoints', () => {
  it('getLibraryItems hits /items with the built query and returns results with total', async () => {
    const fetcher = jsonFetcher({ results: [{ id: 'b1' }], total: 130, limit: 48, page: 2 })
    const client = createAbsClient({ session, fetcher: fetcher as unknown as typeof fetch })

    const response = await client.getLibraryItems('lib 1', { page: 2, sort: 'addedAt', desc: true, filter: progressFilter('in-progress') })

    expect(requestedPath(fetcher)).toBe(`/api/libraries/lib%201/items?limit=48&page=2&sort=addedAt&desc=1&filter=${progressFilter('in-progress')}&minified=1`)
    expect(response.total).toBe(130)
    expect(response.results).toHaveLength(1)
  })

  it('getLibraryItems with no options still works (the old one-argument call shape)', async () => {
    const fetcher = jsonFetcher({ results: [], total: 0 })
    const client = createAbsClient({ session, fetcher: fetcher as unknown as typeof fetch })
    await client.getLibraryItems('lib')
    expect(requestedPath(fetcher)).toBe('/api/libraries/lib/items?limit=48&page=0&sort=media.metadata.title&minified=1')
  })

  it('getLibraryPersonalized requests ten per shelf with rssfeed,share and passes shelves through untouched', async () => {
    const shelves = [
      { id: 'continue-listening', label: 'Continue Listening', labelStringKey: 'LabelContinueListening', type: 'book', entities: [], total: 0 },
      { id: 'a-shelf-from-the-future', label: 'Future', labelStringKey: 'LabelFuture', type: 'hologram', entities: [{ any: 'thing' }], total: 1 }
    ]
    const fetcher = jsonFetcher(shelves)
    const client = createAbsClient({ session, fetcher: fetcher as unknown as typeof fetch })

    const result = await client.getLibraryPersonalized('lib')

    expect(requestedPath(fetcher)).toBe('/api/libraries/lib/personalized?limit=10&include=rssfeed,share')
    expect(result).toEqual(shelves)
  })

  it('getFilterData hits /filterdata', async () => {
    const data = { authors: [{ id: 'au_1', name: 'A' }], genres: ['Fantasy'], tags: [], series: [], narrators: [], languages: [] }
    const fetcher = jsonFetcher(data)
    const client = createAbsClient({ session, fetcher: fetcher as unknown as typeof fetch })
    expect(await client.getFilterData('lib')).toEqual(data)
    expect(requestedPath(fetcher)).toBe('/api/libraries/lib/filterdata')
  })

  it('getMe hits /api/me and returns the media progress list for buildProgressMap', async () => {
    const me = { id: 'u1', username: 'x', mediaProgress: [{ id: 'mp1', libraryItemId: 'li_1', episodeId: null, progress: 0.4, currentTime: 4, duration: 10, isFinished: false }] }
    const fetcher = jsonFetcher(me)
    const client = createAbsClient({ session, fetcher: fetcher as unknown as typeof fetch })

    const user = await client.getMe()

    expect(requestedPath(fetcher)).toBe('/api/me')
    expect(getProgress(buildProgressMap(user.mediaProgress), 'li_1')?.progress).toBe(0.4)
  })
})
