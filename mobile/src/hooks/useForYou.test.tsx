import type { DiscoverBrowseResponse, DiscoverItem } from '@abs/acquisition-contract'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AbsClient } from '../api/absClient'
import { buildProgressMap } from '../api/progressMap'
import type { MobileAcquisitionClient } from '../api/acquisitionClient'
import { AuthContext, type AuthContextValue } from '../auth/AuthProvider'
import { UserProgressContext, type UserProgressContextValue, type UserProgressStatus } from '../progress/UserProgressProvider'
import type { AbsLibraryItem, AbsUserMediaProgress } from '../types/abs'
import { useForYou } from './useForYou'

let libraryCounter = 0
function freshLibraryId() {
  return `lib-foryou-${++libraryCounter}`
}

function libraryItem(id: string, genres: string[]): AbsLibraryItem {
  return { id, libraryId: 'lib', media: { metadata: { title: `Title ${id}`, authorName: `Author ${id}`, genres }, duration: 36000 } }
}

function progressRow(libraryItemId: string, overrides: Record<string, unknown> = {}): AbsUserMediaProgress {
  return {
    id: `mp_${libraryItemId}`,
    libraryItemId,
    episodeId: null,
    mediaItemType: 'book',
    currentTime: 20000,
    duration: 36000,
    progress: 0.5,
    isFinished: false,
    lastUpdate: Date.now(),
    ...overrides
  } as AbsUserMediaProgress
}

function discoverItem(n: number): DiscoverItem {
  return { key: `/works/OL${n}W`, title: `Suggestion ${n}`, author: `Writer ${n}`, coverUrl: null, year: null, popularity: n }
}

function discoverItems(from: number, count: number): DiscoverItem[] {
  return Array.from({ length: count }, (_, i) => discoverItem(from + i))
}

function browsePage(items: DiscoverItem[], status: DiscoverBrowseResponse['status'] = 'ok', partial = false): DiscoverBrowseResponse {
  return { status, catalog: 'popular', genre: '', offset: 0, nextOffset: null, partial, items }
}

interface Setup {
  libraryItems: AbsLibraryItem[]
  progress: AbsUserMediaProgress[]
  progressStatus?: UserProgressStatus
  browseDiscover: unknown
  getLibraryItems?: unknown
}

function render(setup: Setup) {
  const libraryId = freshLibraryId()
  const auth: AuthContextValue = {
    state: { status: 'authenticated', serverUrl: 'https://books.test' },
    client: { getLibraryItems: setup.getLibraryItems ?? vi.fn().mockResolvedValue({ results: setup.libraryItems, total: setup.libraryItems.length }) } as unknown as AbsClient,
    acquisitionClient: { browseDiscover: setup.browseDiscover } as unknown as MobileAcquisitionClient,
    login: vi.fn(),
    logout: vi.fn()
  }
  const progressValue: UserProgressContextValue = {
    progressMap: buildProgressMap(setup.progress),
    getProgress: vi.fn(),
    status: setup.progressStatus ?? 'ready',
    refresh: vi.fn().mockResolvedValue(undefined)
  }
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AuthContext.Provider value={auth}>
      <UserProgressContext.Provider value={progressValue}>{children}</UserProgressContext.Provider>
    </AuthContext.Provider>
  )
  return renderHook(() => useForYou(libraryId), { wrapper })
}

/** Two genres: Fantasy outweighs Science Fiction, so the order of requests is deterministic. */
const FANTASY_AND_SCIFI = {
  libraryItems: [libraryItem('a', ['Fantasy']), libraryItem('b', ['Science Fiction'])],
  progress: [progressRow('a', { currentTime: 30000 }), progressRow('b', { currentTime: 10000 })]
}

afterEach(() => vi.restoreAllMocks())

describe('useForYou', () => {
  it('is empty, and makes no request, when there is no listening history', async () => {
    const browseDiscover = vi.fn()
    const { result } = render({ libraryItems: [libraryItem('a', ['Fantasy'])], progress: [], browseDiscover })

    await waitFor(() => expect(result.current.status).toBe('empty'))
    expect(result.current.rows).toEqual([])
    expect(result.current.incomplete).toBe(false)
    expect(browseDiscover).not.toHaveBeenCalled()
  })

  it('ignores podcast episodes, non-book rows and items absent from the library', async () => {
    const browseDiscover = vi.fn()
    const { result } = render({
      libraryItems: [libraryItem('a', ['Fantasy']), libraryItem('b', ['Fantasy']), libraryItem('c', ['Fantasy'])],
      progress: [
        progressRow('a', { episodeId: 'ep1' }),
        progressRow('b', { mediaItemType: 'podcastEpisode' }),
        progressRow('missing')
      ],
      browseDiscover
    })

    await waitFor(() => expect(result.current.status).toBe('empty'))
    expect(browseDiscover).not.toHaveBeenCalled()
  })

  it('builds one popular row per top genre', async () => {
    const browseDiscover = vi.fn(async (params: { genre?: string }) => (params.genre === 'Fantasy' ? browsePage(discoverItems(1, 5)) : browsePage(discoverItems(100, 3))))
    const { result } = render({ ...FANTASY_AND_SCIFI, browseDiscover })

    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.rows.map((row) => row.genre)).toEqual(['Fantasy', 'Science Fiction'])
    expect(result.current.rows[0]?.items).toHaveLength(5)
    expect(result.current.incomplete).toBe(false)
    expect(browseDiscover.mock.calls.map((call) => call[0])).toEqual([
      { catalog: 'popular', genre: 'Fantasy', offset: 0 },
      { catalog: 'popular', genre: 'Science Fiction', offset: 0 }
    ])
  })

  it('keeps the rows that worked and flags incomplete when one genre fails', async () => {
    const browseDiscover = vi.fn(async (params: { genre?: string }) => {
      if (params.genre === 'Science Fiction') throw new Error('Open Library down')
      return browsePage(discoverItems(1, 4))
    })
    const { result } = render({ ...FANTASY_AND_SCIFI, browseDiscover })

    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.rows.map((row) => row.genre)).toEqual(['Fantasy'])
    expect(result.current.incomplete).toBe(true)
  })

  it('reports error, not empty, when every genre request fails', async () => {
    const browseDiscover = vi.fn().mockRejectedValue(new Error('Open Library down'))
    const { result } = render({ ...FANTASY_AND_SCIFI, browseDiscover })

    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.rows).toEqual([])
  })

  it('drops a genre with no books quietly, without marking incomplete', async () => {
    const browseDiscover = vi.fn(async (params: { genre?: string }) => (params.genre === 'Fantasy' ? browsePage(discoverItems(1, 4)) : browsePage([], 'empty')))
    const { result } = render({ ...FANTASY_AND_SCIFI, browseDiscover })

    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.rows.map((row) => row.genre)).toEqual(['Fantasy'])
    expect(result.current.incomplete).toBe(false)
  })

  it('counts a genre the server rejected (invalid_request) as a failure, not as a quiet empty one', async () => {
    const browseDiscover = vi.fn(async (params: { genre?: string }) => (params.genre === 'Fantasy' ? browsePage(discoverItems(1, 4)) : browsePage([], 'invalid_request')))
    const { result } = render({ ...FANTASY_AND_SCIFI, browseDiscover })

    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.rows.map((row) => row.genre)).toEqual(['Fantasy'])
    expect(result.current.incomplete).toBe(true)
  })

  it('reports error, not "nothing to suggest", when every genre request was rejected', async () => {
    const browseDiscover = vi.fn().mockResolvedValue(browsePage([], 'invalid_request'))
    const { result } = render({ ...FANTASY_AND_SCIFI, browseDiscover })

    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.rows).toEqual([])
    expect(result.current.reason).toBeNull()
  })

  it('is empty (not error) when every genre came back with no books and nothing failed', async () => {
    const browseDiscover = vi.fn().mockResolvedValue(browsePage([], 'empty'))
    const { result } = render({ ...FANTASY_AND_SCIFI, browseDiscover })

    await waitFor(() => expect(result.current.status).toBe('empty'))
    expect(result.current.incomplete).toBe(false)
    expect(result.current.reason).toBe('no-results')
  })

  it('explains an empty state with reason: no-history without any listening history', async () => {
    const { result } = render({ libraryItems: [libraryItem('a', ['Fantasy'])], progress: [], browseDiscover: vi.fn() })

    await waitFor(() => expect(result.current.status).toBe('empty'))
    expect(result.current.reason).toBe('no-history')
  })

  it('has a null reason whenever the status is not empty', async () => {
    const loading = render({ libraryItems: [libraryItem('a', ['Fantasy'])], progress: [], progressStatus: 'loading', browseDiscover: vi.fn() })
    expect(loading.result.current.status).toBe('loading')
    expect(loading.result.current.reason).toBeNull()

    const ready = render({ ...FANTASY_AND_SCIFI, browseDiscover: vi.fn().mockResolvedValue(browsePage(discoverItems(1, 3))) })
    await waitFor(() => expect(ready.result.current.status).toBe('ready'))
    expect(ready.result.current.reason).toBeNull()

    const failed = render({ ...FANTASY_AND_SCIFI, browseDiscover: vi.fn().mockRejectedValue(new Error('down')) })
    await waitFor(() => expect(failed.result.current.status).toBe('error'))
    expect(failed.result.current.reason).toBeNull()
  })

  it('carries each genre\'s partial flag onto its row', async () => {
    const browseDiscover = vi.fn(async (params: { genre?: string }) => (params.genre === 'Fantasy' ? browsePage(discoverItems(1, 4), 'ok', true) : browsePage(discoverItems(100, 3), 'ok', false)))
    const { result } = render({ ...FANTASY_AND_SCIFI, browseDiscover })

    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.rows.map((row) => [row.genre, row.partial])).toEqual([
      ['Fantasy', true],
      ['Science Fiction', false]
    ])
  })

  it('never shows the previous client\'s rows after the client is replaced', async () => {
    const oldClient = { browseDiscover: vi.fn(async () => browsePage(discoverItems(1, 4))) }
    const newClient = { browseDiscover: vi.fn(() => new Promise<DiscoverBrowseResponse>(() => {})) }
    const libraryId = freshLibraryId()
    let current: unknown = oldClient
    const progressValue: UserProgressContextValue = {
      progressMap: buildProgressMap(FANTASY_AND_SCIFI.progress),
      getProgress: vi.fn(),
      status: 'ready',
      refresh: vi.fn().mockResolvedValue(undefined)
    }
    const getLibraryItems = vi.fn().mockResolvedValue({ results: FANTASY_AND_SCIFI.libraryItems, total: 2 })
    const wrapper = ({ children }: { children: ReactNode }) => {
      const auth: AuthContextValue = {
        state: { status: 'authenticated', serverUrl: 'https://books.test' },
        client: { getLibraryItems } as unknown as AbsClient,
        acquisitionClient: current as MobileAcquisitionClient,
        login: vi.fn(),
        logout: vi.fn()
      }
      return (
        <AuthContext.Provider value={auth}>
          <UserProgressContext.Provider value={progressValue}>{children}</UserProgressContext.Provider>
        </AuthContext.Provider>
      )
    }
    const renders: Array<ReturnType<typeof useForYou>> = []
    const { result, rerender } = renderHook(
      () => {
        const value = useForYou(libraryId)
        renders.push(value)
        return value
      },
      { wrapper }
    )
    await waitFor(() => expect(result.current.status).toBe('ready'))

    renders.length = 0
    current = newClient
    rerender()
    await act(async () => {})

    expect(renders.length).toBeGreaterThan(0)
    for (const render of renders) expect(render.rows).toEqual([])
    expect(result.current.status).toBe('loading')
  })

  it('shows a book once: later rows drop what an earlier row already took', async () => {
    const browseDiscover = vi.fn(async (params: { genre?: string }) => (params.genre === 'Fantasy' ? browsePage(discoverItems(1, 3)) : browsePage(discoverItems(2, 4))))
    const { result } = render({ ...FANTASY_AND_SCIFI, browseDiscover })

    await waitFor(() => expect(result.current.status).toBe('ready'))
    const keys = result.current.rows.flatMap((row) => row.items.map((item) => item.key))
    expect(new Set(keys).size).toBe(keys.length)
    expect(result.current.rows[0]?.items.map((item) => item.key)).toEqual(['/works/OL1W', '/works/OL2W', '/works/OL3W'])
    expect(result.current.rows[1]?.items.map((item) => item.key)).toEqual(['/works/OL4W', '/works/OL5W'])
  })

  it('caps each row at 12 cards', async () => {
    const browseDiscover = vi.fn().mockResolvedValue(browsePage(discoverItems(1, 20)))
    const { result } = render({ libraryItems: [libraryItem('a', ['Fantasy'])], progress: [progressRow('a')], browseDiscover })

    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.rows[0]?.items).toHaveLength(12)
  })

  it('never has more than two genre requests in flight', async () => {
    const pending: Array<() => void> = []
    let inFlight = 0
    let peak = 0
    const browseDiscover = vi.fn(
      () =>
        new Promise<DiscoverBrowseResponse>((resolve) => {
          inFlight++
          peak = Math.max(peak, inFlight)
          pending.push(() => {
            inFlight--
            resolve(browsePage(discoverItems(pending.length * 10, 2)))
          })
        })
    )
    const { result } = render({
      libraryItems: [libraryItem('a', ['Fantasy']), libraryItem('b', ['Science Fiction']), libraryItem('c', ['Mystery'])],
      progress: [progressRow('a', { currentTime: 30000 }), progressRow('b', { currentTime: 20000 }), progressRow('c', { currentTime: 10000 })],
      browseDiscover
    })

    await waitFor(() => expect(browseDiscover).toHaveBeenCalledTimes(2))
    expect(peak).toBe(2)
    expect(result.current.status).toBe('loading')

    await act(async () => pending[0]?.())
    await waitFor(() => expect(browseDiscover).toHaveBeenCalledTimes(3))
    expect(peak).toBe(2)

    await act(async () => {
      pending[1]?.()
      pending[2]?.()
    })
    await waitFor(() => expect(result.current.status).toBe('ready'))
  })

  it('reports error, not "no history", when the library failed to load', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const browseDiscover = vi.fn()
    const { result } = render({ ...FANTASY_AND_SCIFI, browseDiscover, getLibraryItems: vi.fn().mockRejectedValue(new Error('offline')) })

    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(browseDiscover).not.toHaveBeenCalled()
  })

  it('reports error, not "no history", when progress failed and nothing was loaded', async () => {
    const browseDiscover = vi.fn()
    const { result } = render({ libraryItems: [libraryItem('a', ['Fantasy'])], progress: [], progressStatus: 'error', browseDiscover })

    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(browseDiscover).not.toHaveBeenCalled()
  })

  it('stays loading while progress is still loading', async () => {
    const { result } = render({ libraryItems: [libraryItem('a', ['Fantasy'])], progress: [], progressStatus: 'loading', browseDiscover: vi.fn() })
    expect(result.current.status).toBe('loading')
    await act(async () => {})
    expect(result.current.status).toBe('loading')
  })
})
