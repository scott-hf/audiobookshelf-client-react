import type { DiscoverBrowseResponse, DiscoverItem } from '@abs/acquisition-contract'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { AcquisitionApiError, type MobileAcquisitionClient } from '../api/acquisitionClient'
import { AuthContext, type AuthContextValue } from '../auth/AuthProvider'
import { type BrowseSelection, GENRE_ALL_ID } from '../lib/discoverBrowse'
import { DISCOVER_INVALID_SELECTION, type UseDiscoverBrowseResult, useDiscoverBrowse } from './useDiscoverBrowse'

function book(n: number): DiscoverItem {
  return { key: `/works/OL${n}W`, title: `Book ${n}`, author: `Author ${n}`, coverUrl: null, year: null, popularity: n }
}

function books(from: number, count: number): DiscoverItem[] {
  return Array.from({ length: count }, (_, i) => book(from + i))
}

function page(items: DiscoverItem[], overrides: Partial<DiscoverBrowseResponse> = {}): DiscoverBrowseResponse {
  return { status: 'ok', catalog: 'popular', genre: '', offset: 0, nextOffset: 20, partial: false, items, ...overrides }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function catalog(catalogId: string, genreId: string | null = null): BrowseSelection {
  return { kind: 'catalog', catalogId, genreId, genreLabel: genreId }
}

function wrapperFor(browseDiscover: unknown) {
  const value: AuthContextValue = {
    state: { status: 'authenticated', serverUrl: 'https://books.test' },
    client: {} as AuthContextValue['client'],
    acquisitionClient: { browseDiscover } as unknown as MobileAcquisitionClient,
    login: vi.fn(),
    logout: vi.fn()
  }
  return function Wrapper({ children }: { children: ReactNode }) {
    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
  }
}

function setup(browseDiscover: ReturnType<typeof vi.fn>, initial: BrowseSelection = catalog('popular')) {
  return renderHook(({ selection }) => useDiscoverBrowse(selection), { wrapper: wrapperFor(browseDiscover), initialProps: { selection: initial } })
}

describe('useDiscoverBrowse', () => {
  it('loads the first page at offset 0 and reports the server cursor', async () => {
    const browseDiscover = vi.fn().mockResolvedValue(page(books(1, 20), { nextOffset: 20 }))
    const { result } = setup(browseDiscover)

    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.items).toHaveLength(20)
    expect(result.current.nextOffset).toBe(20)
    expect(result.current.hasMore).toBe(true)
    expect(browseDiscover).toHaveBeenCalledTimes(1)
    expect(browseDiscover.mock.calls[0]?.[0]).toEqual({ catalog: 'popular', offset: 0 })
  })

  it('sends the genre, but never the all-genres sentinel', async () => {
    const withGenre = vi.fn().mockResolvedValue(page(books(1, 3), { nextOffset: null }))
    setup(withGenre, catalog('popular', 'Fantasy'))
    await waitFor(() => expect(withGenre).toHaveBeenCalled())
    expect(withGenre.mock.calls[0]?.[0]).toEqual({ catalog: 'popular', genre: 'Fantasy', offset: 0 })

    const withAll = vi.fn().mockResolvedValue(page(books(1, 3), { nextOffset: null }))
    setup(withAll, catalog('popular', GENRE_ALL_ID))
    await waitFor(() => expect(withAll).toHaveBeenCalled())
    expect(withAll.mock.calls[0]?.[0]).toEqual({ catalog: 'popular', offset: 0 })
  })

  it('loadMore requests the server nextOffset and appends', async () => {
    const browseDiscover = vi
      .fn()
      .mockResolvedValueOnce(page(books(1, 20), { nextOffset: 20 }))
      .mockResolvedValueOnce(page(books(21, 20), { offset: 20, nextOffset: null }))
    const { result } = setup(browseDiscover)
    await waitFor(() => expect(result.current.status).toBe('ready'))

    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.items).toHaveLength(40))

    expect(browseDiscover.mock.calls[1]?.[0]).toEqual({ catalog: 'popular', offset: 20 })
    expect(result.current.hasMore).toBe(false)
    expect(result.current.nextOffset).toBeNull()
    expect(result.current.loadingMore).toBe(false)
  })

  it('fires ONE request for a double loadMore in the same tick', async () => {
    const second = deferred<DiscoverBrowseResponse>()
    const browseDiscover = vi.fn().mockResolvedValueOnce(page(books(1, 20), { nextOffset: 20 })).mockReturnValueOnce(second.promise)
    const { result } = setup(browseDiscover)
    await waitFor(() => expect(result.current.status).toBe('ready'))

    act(() => {
      result.current.loadMore()
      result.current.loadMore()
    })
    expect(browseDiscover).toHaveBeenCalledTimes(2) // first page + exactly one follow-up
    expect(result.current.loadingMore).toBe(true)

    await act(async () => {
      second.resolve(page(books(21, 5), { offset: 20, nextOffset: null }))
    })
    expect(result.current.items).toHaveLength(25)
    expect(browseDiscover).toHaveBeenCalledTimes(2)
  })

  it('a 7-item page with a non-null nextOffset still has more', async () => {
    const browseDiscover = vi.fn().mockResolvedValue(page(books(1, 7), { nextOffset: 20 }))
    const { result } = setup(browseDiscover)

    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.items).toHaveLength(7)
    expect(result.current.hasMore).toBe(true)
    expect(result.current.nextOffset).toBe(20)
  })

  it('a null nextOffset ends paging and loadMore is then a no-op', async () => {
    const browseDiscover = vi.fn().mockResolvedValue(page(books(1, 20), { nextOffset: null }))
    const { result } = setup(browseDiscover)
    await waitFor(() => expect(result.current.status).toBe('ready'))

    expect(result.current.hasMore).toBe(false)
    act(() => result.current.loadMore())
    expect(browseDiscover).toHaveBeenCalledTimes(1)
  })

  it('a failed loadMore keeps the loaded cards and the retry resumes at the failed cursor', async () => {
    const browseDiscover = vi
      .fn()
      .mockResolvedValueOnce(page(books(1, 20), { nextOffset: 20 }))
      .mockRejectedValueOnce(new AcquisitionApiError(502, 'discover_upstream_unavailable', 'down'))
      .mockResolvedValueOnce(page(books(21, 20), { offset: 20, nextOffset: 40 }))
    const { result } = setup(browseDiscover)
    await waitFor(() => expect(result.current.status).toBe('ready'))

    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.loadMoreFailed).toBe(true))
    expect(result.current.items).toHaveLength(20)
    expect(result.current.status).toBe('ready')
    expect(result.current.loadingMore).toBe(false)
    expect(result.current.nextOffset).toBe(20)
    expect(result.current.errorCode).toBe('discover_upstream_unavailable')

    act(() => result.current.retry())
    await waitFor(() => expect(result.current.items).toHaveLength(40))
    expect(browseDiscover.mock.calls[2]?.[0]).toEqual({ catalog: 'popular', offset: 20 })
    expect(result.current.loadMoreFailed).toBe(false)
    expect(result.current.nextOffset).toBe(40)
  })

  it('keeps invalid, empty and error apart', async () => {
    const invalid = setup(vi.fn().mockResolvedValue(page([], { status: 'invalid_request', nextOffset: null })))
    const empty = setup(vi.fn().mockResolvedValue(page([], { status: 'empty', nextOffset: null })))
    const failed = setup(vi.fn().mockRejectedValue(new AcquisitionApiError(429, 'discover_rate_limited', 'slow down')))

    await waitFor(() => expect(invalid.result.current.status).toBe('invalid'))
    await waitFor(() => expect(empty.result.current.status).toBe('empty'))
    await waitFor(() => expect(failed.result.current.status).toBe('error'))
    expect(failed.result.current.errorCode).toBe('discover_rate_limited')
    expect(empty.result.current.errorCode).toBeNull()
    expect(invalid.result.current.errorCode).toBeNull()
  })

  it('keeps a live cursor on an empty first page, even when the status says empty', async () => {
    const browseDiscover = vi
      .fn()
      .mockResolvedValueOnce(page([], { status: 'empty', nextOffset: 20 }))
      .mockResolvedValueOnce(page(books(1, 3), { offset: 20, nextOffset: null }))
    const { result } = setup(browseDiscover)

    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.items).toEqual([])
    expect(result.current.hasMore).toBe(true)
    expect(result.current.nextOffset).toBe(20)

    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.items).toHaveLength(3))
    expect(browseDiscover.mock.calls[1]?.[0]).toEqual({ catalog: 'popular', offset: 20 })
  })

  it('ends the shelf for a blank page whose cursor does not move forward', async () => {
    // safeNext() turns a cursor that is not past the request into null, so there is nowhere to go.
    const stuck = setup(vi.fn().mockResolvedValue(page([], { status: 'empty', nextOffset: 0 })))
    const ok = setup(vi.fn().mockResolvedValue(page([], { status: 'ok', nextOffset: null })))

    await waitFor(() => expect(stuck.result.current.status).toBe('empty'))
    await waitFor(() => expect(ok.result.current.status).toBe('empty'))
    expect(stuck.result.current.hasMore).toBe(false)
    expect(ok.result.current.hasMore).toBe(false)
  })

  it('an invalid LATER page keeps the cards, drops the cursor, and a retry cannot resend it', async () => {
    const browseDiscover = vi
      .fn()
      .mockResolvedValueOnce(page(books(1, 20), { nextOffset: 20 }))
      .mockResolvedValueOnce(page([], { status: 'invalid_request', offset: 20, nextOffset: null }))
    const { result } = setup(browseDiscover)
    await waitFor(() => expect(result.current.status).toBe('ready'))

    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.loadMoreFailed).toBe(true))
    expect(result.current.status).toBe('ready')
    expect(result.current.items).toHaveLength(20)
    expect(result.current.nextOffset).toBeNull()
    expect(result.current.hasMore).toBe(false)
    expect(result.current.loadingMore).toBe(false)
    expect(result.current.errorCode).toBe('discover_invalid_selection')
    expect(result.current.errorCode).toBe(DISCOVER_INVALID_SELECTION)

    act(() => result.current.retry())
    act(() => result.current.loadMore())
    expect(browseDiscover).toHaveBeenCalledTimes(2) // first page + the one rejected request, never a third
  })

  it('never shows the previous client\'s cards after the client is replaced', async () => {
    const oldClient = { browseDiscover: vi.fn().mockResolvedValue(page(books(1, 5), { nextOffset: 20 })) }
    const newPage = deferred<DiscoverBrowseResponse>()
    const newClient = { browseDiscover: vi.fn().mockReturnValue(newPage.promise) }
    let current: unknown = oldClient
    const renders: UseDiscoverBrowseResult[] = []
    const wrapper = ({ children }: { children: ReactNode }) => {
      const value: AuthContextValue = {
        state: { status: 'authenticated', serverUrl: 'https://books.test' },
        client: {} as AuthContextValue['client'],
        acquisitionClient: current as MobileAcquisitionClient,
        login: vi.fn(),
        logout: vi.fn()
      }
      return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
    }
    const { result, rerender } = renderHook(
      () => {
        const value = useDiscoverBrowse(catalog('popular'))
        renders.push(value)
        return value
      },
      { wrapper }
    )
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.items).toHaveLength(5)

    renders.length = 0
    current = newClient
    rerender()

    // Same selection, new client: not one render may carry the old client's cards or cursor.
    expect(renders.length).toBeGreaterThan(0)
    for (const render of renders) {
      expect(render.items).toEqual([])
      expect(render.nextOffset).toBeNull()
      expect(render.status).toBe('loading')
    }
    await act(async () => {
      newPage.resolve(page(books(50, 2), { nextOffset: null }))
    })
    expect(result.current.items.map((item) => item.title)).toEqual(['Book 50', 'Book 51'])
  })

  it('retry after a first-page error loads the first page again', async () => {
    const browseDiscover = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(page(books(1, 4), { nextOffset: null }))
    const { result } = setup(browseDiscover)
    await waitFor(() => expect(result.current.status).toBe('error'))

    act(() => result.current.retry())
    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(browseDiscover.mock.calls[1]?.[0]).toEqual({ catalog: 'popular', offset: 0 })
  })

  it('surfaces partial', async () => {
    const browseDiscover = vi.fn().mockResolvedValue(page(books(1, 5), { partial: true, nextOffset: null }))
    const { result } = setup(browseDiscover)

    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.partial).toBe(true)
  })

  it('discards a late response from a superseded selection and aborts it', async () => {
    const stale = deferred<DiscoverBrowseResponse>()
    const fresh = deferred<DiscoverBrowseResponse>()
    const signals: AbortSignal[] = []
    const browseDiscover = vi.fn((params: { catalog: string }, options?: { signal?: AbortSignal }) => {
      if (options?.signal) signals.push(options.signal)
      return params.catalog === 'popular' ? stale.promise : fresh.promise
    })
    const { result, rerender } = setup(browseDiscover as unknown as ReturnType<typeof vi.fn>)

    rerender({ selection: catalog('top_rated') })
    expect(signals[0]?.aborted).toBe(true)
    expect(result.current.status).toBe('loading')

    await act(async () => {
      fresh.resolve(page(books(100, 3), { catalog: 'top_rated', nextOffset: null }))
    })
    expect(result.current.items.map((item) => item.title)).toEqual(['Book 100', 'Book 101', 'Book 102'])

    // The old selection finally answers: it must not clobber the new one.
    await act(async () => {
      stale.resolve(page(books(1, 20)))
    })
    expect(result.current.items.map((item) => item.title)).toEqual(['Book 100', 'Book 101', 'Book 102'])
    expect(result.current.hasMore).toBe(false)
  })

  it('a late FAILURE from a superseded request does not touch the newer request', async () => {
    const firstPage = page(books(1, 20), { nextOffset: 20 })
    const staleMore = deferred<DiscoverBrowseResponse>()
    const freshFirst = deferred<DiscoverBrowseResponse>()
    const browseDiscover = vi.fn((params: { catalog: string; offset: number }) => {
      if (params.catalog === 'popular') return params.offset === 0 ? Promise.resolve(firstPage) : staleMore.promise
      return freshFirst.promise
    })
    const { result, rerender } = setup(browseDiscover as unknown as ReturnType<typeof vi.fn>)
    await waitFor(() => expect(result.current.status).toBe('ready'))

    act(() => result.current.loadMore())
    expect(result.current.loadingMore).toBe(true)

    rerender({ selection: catalog('top_rated') })
    expect(result.current.status).toBe('loading')

    // The superseded loadMore dies late; the new selection is still loading, untouched.
    await act(async () => {
      staleMore.reject(new Error('aborted'))
    })
    expect(result.current.status).toBe('loading')
    expect(result.current.loadMoreFailed).toBe(false)
    expect(result.current.errorCode).toBeNull()

    await act(async () => {
      freshFirst.resolve(page(books(50, 2), { catalog: 'top_rated', nextOffset: null }))
    })
    expect(result.current.status).toBe('ready')
    expect(result.current.items).toHaveLength(2)
  })

  it('aborts the in-flight request on unmount', async () => {
    let signal: AbortSignal | undefined
    const browseDiscover = vi.fn((_params: unknown, options?: { signal?: AbortSignal }) => {
      signal = options?.signal
      return new Promise<DiscoverBrowseResponse>(() => {})
    })
    const { unmount } = setup(browseDiscover as unknown as ReturnType<typeof vi.fn>)
    await waitFor(() => expect(signal).toBeDefined())

    unmount()
    expect(signal?.aborted).toBe(true)
  })

  it('stays idle for a forYou selection', () => {
    const browseDiscover = vi.fn()
    const { result } = setup(browseDiscover, { kind: 'forYou' })

    expect(browseDiscover).not.toHaveBeenCalled()
    expect(result.current.items).toEqual([])
    expect(result.current.hasMore).toBe(false)
    act(() => result.current.loadMore())
    expect(browseDiscover).not.toHaveBeenCalled()
  })
})
