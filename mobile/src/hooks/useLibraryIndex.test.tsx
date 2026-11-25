import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AbsClient } from '../api/absClient'
import { AuthContext, type AuthContextValue } from '../auth/AuthProvider'
import { findOwned } from '../lib/discoverBrowse'
import type { AbsLibraryItem } from '../types/abs'
import { useLibraryIndex } from './useLibraryIndex'

function libraryItem(id: string, title: string, author = 'Some Author', genres: string[] = []): AbsLibraryItem {
  return { id, libraryId: 'lib', media: { metadata: { title, authorName: author, genres } } }
}

function manyItems(from: number, count: number): AbsLibraryItem[] {
  return Array.from({ length: count }, (_, i) => libraryItem(`li_${from + i}`, `Title ${from + i}`))
}

function wrapperFor(getLibraryItems: unknown) {
  const value: AuthContextValue = {
    state: { status: 'authenticated', serverUrl: 'https://books.test' },
    client: { getLibraryItems } as unknown as AbsClient,
    acquisitionClient: null,
    login: vi.fn(),
    logout: vi.fn()
  }
  return function Wrapper({ children }: { children: ReactNode }) {
    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
  }
}

afterEach(() => vi.restoreAllMocks())

describe('useLibraryIndex', () => {
  it('pages with minified newest-first requests until total is reached', async () => {
    const getLibraryItems = vi
      .fn()
      .mockResolvedValueOnce({ results: manyItems(0, 500), total: 750 })
      .mockResolvedValueOnce({ results: manyItems(500, 250), total: 750 })
    const { result } = renderHook(() => useLibraryIndex('lib-paging'), { wrapper: wrapperFor(getLibraryItems) })

    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.items).toHaveLength(750)
    expect(getLibraryItems).toHaveBeenCalledTimes(2)
    expect(getLibraryItems.mock.calls[0]).toEqual(['lib-paging', { page: 0, limit: 500, minified: true, sort: 'addedAt', desc: true }])
    expect(getLibraryItems.mock.calls[1]?.[1]).toMatchObject({ page: 1, limit: 500 })
  })

  it('builds an owned index over the loaded items', async () => {
    const getLibraryItems = vi.fn().mockResolvedValue({ results: [libraryItem('li_dune', 'Dune', 'Frank Herbert', ['Science Fiction'])], total: 1 })
    const { result } = renderHook(() => useLibraryIndex('lib-index'), { wrapper: wrapperFor(getLibraryItems) })

    await waitFor(() => expect(result.current.status).toBe('ready'))
    const match = findOwned(result.current.index, 'Dune', 'Frank Herbert')
    expect(match.kind).toBe('confident')
    expect(match.kind === 'confident' && match.entry.id).toBe('li_dune')
    expect(findOwned(result.current.index, 'Emma', 'Jane Austen').kind).toBe('none')
  })

  it('stops on a page that adds nothing new instead of looping', async () => {
    // The server ignores `page` and keeps returning the same 3 items while claiming total 10.
    const getLibraryItems = vi.fn().mockResolvedValue({ results: manyItems(0, 3), total: 10 })
    const { result } = renderHook(() => useLibraryIndex('lib-stuck'), { wrapper: wrapperFor(getLibraryItems) })

    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.items).toHaveLength(3)
    expect(getLibraryItems).toHaveBeenCalledTimes(2)
  })

  it('stops on an empty page before total is reached', async () => {
    const getLibraryItems = vi.fn().mockResolvedValueOnce({ results: manyItems(0, 5), total: 50 }).mockResolvedValueOnce({ results: [], total: 50 })
    const { result } = renderHook(() => useLibraryIndex('lib-short'), { wrapper: wrapperFor(getLibraryItems) })

    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.items).toHaveLength(5)
    expect(getLibraryItems).toHaveBeenCalledTimes(2)
  })

  it('reports error without throwing, with an empty (but usable) index', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const getLibraryItems = vi.fn().mockRejectedValue(new Error('offline'))
    const { result } = renderHook(() => useLibraryIndex('lib-fail'), { wrapper: wrapperFor(getLibraryItems) })

    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.items).toEqual([])
    expect(findOwned(result.current.index, 'Dune', 'Frank Herbert').kind).toBe('none')
  })

  it('does not cache a failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const getLibraryItems = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ results: manyItems(0, 2), total: 2 })
    const wrapper = wrapperFor(getLibraryItems)

    const first = renderHook(() => useLibraryIndex('lib-retry'), { wrapper })
    await waitFor(() => expect(first.result.current.status).toBe('error'))
    first.unmount()

    const second = renderHook(() => useLibraryIndex('lib-retry'), { wrapper })
    await waitFor(() => expect(second.result.current.status).toBe('ready'))
    expect(second.result.current.items).toHaveLength(2)
  })

  it('reuses the cache on remount and refetches when the library changes', async () => {
    const getLibraryItems = vi.fn((libraryId: string) => Promise.resolve({ results: [libraryItem(`${libraryId}_a`, `Book of ${libraryId}`)], total: 1 }))
    const wrapper = wrapperFor(getLibraryItems)

    const first = renderHook(() => useLibraryIndex('lib-a'), { wrapper })
    await waitFor(() => expect(first.result.current.status).toBe('ready'))
    first.unmount()

    const { result, rerender } = renderHook(({ id }) => useLibraryIndex(id), { wrapper, initialProps: { id: 'lib-a' } })
    expect(result.current.status).toBe('ready') // straight from cache
    expect(getLibraryItems).toHaveBeenCalledTimes(1)

    rerender({ id: 'lib-b' })
    // Never shows lib-a's books under lib-b, not even for one render.
    expect(result.current.status).toBe('loading')
    expect(result.current.items).toEqual([])
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.items.map((item) => item.id)).toEqual(['lib-b_a'])
    expect(getLibraryItems).toHaveBeenCalledTimes(2)
  })

  it('evicts every other session\'s entries, so going back to the old session refetches', async () => {
    const oldSession = vi.fn().mockResolvedValue({ results: manyItems(0, 2), total: 2 })
    const newSession = vi.fn().mockResolvedValue({ results: manyItems(0, 3), total: 3 })
    const oldWrapper = wrapperFor(oldSession)
    const newWrapper = wrapperFor(newSession)

    const a = renderHook(() => useLibraryIndex('lib-evict-2'), { wrapper: oldWrapper })
    await waitFor(() => expect(a.result.current.status).toBe('ready'))
    a.unmount()
    const b = renderHook(() => useLibraryIndex('lib-evict-2'), { wrapper: newWrapper })
    await waitFor(() => expect(b.result.current.status).toBe('ready'))
    b.unmount()

    // The newest session is still cached ...
    const bAgain = renderHook(() => useLibraryIndex('lib-evict-2'), { wrapper: newWrapper })
    expect(bAgain.result.current.status).toBe('ready')
    expect(newSession).toHaveBeenCalledTimes(1)
    bAgain.unmount()

    // ... the superseded one was dropped when the newer session wrote.
    const aAgain = renderHook(() => useLibraryIndex('lib-evict-2'), { wrapper: oldWrapper })
    expect(aAgain.result.current.status).toBe('loading')
    await waitFor(() => expect(aAgain.result.current.status).toBe('ready'))
    expect(oldSession).toHaveBeenCalledTimes(2)
  })

  it('does not let a late write from a replaced session evict the live session', async () => {
    let finishOld!: (value: { results: AbsLibraryItem[]; total: number }) => void
    const oldSession = vi.fn().mockReturnValue(new Promise((resolve) => (finishOld = resolve)))
    const newSession = vi.fn().mockResolvedValue({ results: manyItems(0, 3), total: 3 })
    const oldWrapper = wrapperFor(oldSession)
    const newWrapper = wrapperFor(newSession)

    const a = renderHook(() => useLibraryIndex('lib-late'), { wrapper: oldWrapper }) // minted first
    await waitFor(() => expect(oldSession).toHaveBeenCalledTimes(1))
    const b = renderHook(() => useLibraryIndex('lib-late'), { wrapper: newWrapper })
    await waitFor(() => expect(b.result.current.status).toBe('ready'))

    // The replaced session's request finally answers.
    await act(async () => finishOld({ results: manyItems(0, 2), total: 2 }))
    a.unmount()
    b.unmount()

    const bAgain = renderHook(() => useLibraryIndex('lib-late'), { wrapper: newWrapper })
    expect(bAgain.result.current.status).toBe('ready') // still cached
    expect(bAgain.result.current.items).toHaveLength(3)
    expect(newSession).toHaveBeenCalledTimes(1)
  })

  it('expires an entry after the TTL', async () => {
    let now = 5_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const getLibraryItems = vi.fn().mockResolvedValue({ results: manyItems(0, 2), total: 2 })
    const wrapper = wrapperFor(getLibraryItems)

    const first = renderHook(() => useLibraryIndex('lib-ttl'), { wrapper })
    await waitFor(() => expect(first.result.current.status).toBe('ready'))
    first.unmount()

    now += 4 * 60 * 1000
    const within = renderHook(() => useLibraryIndex('lib-ttl'), { wrapper })
    expect(within.result.current.status).toBe('ready')
    within.unmount()
    expect(getLibraryItems).toHaveBeenCalledTimes(1)

    now += 2 * 60 * 1000
    const after = renderHook(() => useLibraryIndex('lib-ttl'), { wrapper })
    expect(after.result.current.status).toBe('loading')
    await waitFor(() => expect(after.result.current.status).toBe('ready'))
    expect(getLibraryItems).toHaveBeenCalledTimes(2)
  })

  it('shares one request between concurrent consumers', async () => {
    const getLibraryItems = vi.fn().mockResolvedValue({ results: manyItems(0, 2), total: 2 })
    const wrapper = wrapperFor(getLibraryItems)

    const one = renderHook(() => useLibraryIndex('lib-shared'), { wrapper })
    const two = renderHook(() => useLibraryIndex('lib-shared'), { wrapper })
    await waitFor(() => expect(one.result.current.status).toBe('ready'))
    await waitFor(() => expect(two.result.current.status).toBe('ready'))
    expect(getLibraryItems).toHaveBeenCalledTimes(1)
  })

  it('stays loading without a library id and makes no request', async () => {
    const getLibraryItems = vi.fn()
    const { result } = renderHook(() => useLibraryIndex(undefined), { wrapper: wrapperFor(getLibraryItems) })

    await act(async () => {})
    expect(result.current.status).toBe('loading')
    expect(getLibraryItems).not.toHaveBeenCalled()
  })
})
