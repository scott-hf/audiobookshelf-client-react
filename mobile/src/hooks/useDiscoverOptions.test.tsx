import type { DiscoverOptionsResponse } from '@abs/acquisition-contract'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AcquisitionApiError, type MobileAcquisitionClient } from '../api/acquisitionClient'
import { AuthContext, type AuthContextValue } from '../auth/AuthProvider'
import { useDiscoverOptions } from './useDiscoverOptions'

const OPTIONS: DiscoverOptionsResponse = {
  catalogs: [
    { id: 'popular', label: 'Popular' },
    { id: 'top_rated', label: 'Top rated' }
  ],
  genres: [{ id: 'fantasy', label: 'Fantasy' }]
}

function wrapperFor(acquisitionClient: unknown) {
  const value: AuthContextValue = {
    state: { status: 'authenticated', serverUrl: 'https://books.test' },
    client: {} as AuthContextValue['client'],
    acquisitionClient: acquisitionClient as MobileAcquisitionClient,
    login: vi.fn(),
    logout: vi.fn()
  }
  return function Wrapper({ children }: { children: ReactNode }) {
    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
  }
}

describe('useDiscoverOptions', () => {
  it('loads the options and reports ready', async () => {
    const getDiscoverOptions = vi.fn().mockResolvedValue(OPTIONS)
    const { result } = renderHook(() => useDiscoverOptions(), { wrapper: wrapperFor({ getDiscoverOptions }) })

    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.options).toEqual(OPTIONS)
  })

  it('drops a server catalog that collides with the client-only for_you id', async () => {
    const getDiscoverOptions = vi.fn().mockResolvedValue({ ...OPTIONS, catalogs: [{ id: 'for_you', label: 'Server For You' }, ...OPTIONS.catalogs] })
    const { result } = renderHook(() => useDiscoverOptions(), { wrapper: wrapperFor({ getDiscoverOptions }) })

    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.options?.catalogs.map((catalog) => catalog.id)).toEqual(['popular', 'top_rated'])
  })

  it('hides browse only for a confirmed discover_not_supported', async () => {
    const getDiscoverOptions = vi.fn().mockRejectedValue(new AcquisitionApiError(404, 'discover_not_supported', 'no discover here'))
    const { result } = renderHook(() => useDiscoverOptions(), { wrapper: wrapperFor({ getDiscoverOptions }) })

    await waitFor(() => expect(result.current.status).toBe('hidden'))
    expect(result.current.options).toBeNull()
  })

  it('treats a bare 404 (a host that does not route the gateway) as hidden too', async () => {
    const getDiscoverOptions = vi.fn().mockRejectedValue(new AcquisitionApiError(404, 'unknown', 'not found'))
    const { result } = renderHook(() => useDiscoverOptions(), { wrapper: wrapperFor({ getDiscoverOptions }) })

    await waitFor(() => expect(result.current.status).toBe('hidden'))
  })

  it('reports error (not hidden) for a 500, and retry asks again', async () => {
    const getDiscoverOptions = vi.fn().mockRejectedValueOnce(new AcquisitionApiError(500, 'internal_error', 'boom')).mockResolvedValueOnce(OPTIONS)
    const { result } = renderHook(() => useDiscoverOptions(), { wrapper: wrapperFor({ getDiscoverOptions }) })

    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.options).toBeNull()

    act(() => result.current.retry())
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(getDiscoverOptions).toHaveBeenCalledTimes(2)
  })

  it('reports error for a network failure', async () => {
    const getDiscoverOptions = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    const { result } = renderHook(() => useDiscoverOptions(), { wrapper: wrapperFor({ getDiscoverOptions }) })

    await waitFor(() => expect(result.current.status).toBe('error'))
  })

  it('fetches once per client: a remount reuses the settled answer', async () => {
    const getDiscoverOptions = vi.fn().mockResolvedValue(OPTIONS)
    const wrapper = wrapperFor({ getDiscoverOptions })

    const first = renderHook(() => useDiscoverOptions(), { wrapper })
    await waitFor(() => expect(first.result.current.status).toBe('ready'))
    first.unmount()

    const second = renderHook(() => useDiscoverOptions(), { wrapper })
    // Ready on the very first render: no loading flash, no second request.
    expect(second.result.current.status).toBe('ready')
    expect(getDiscoverOptions).toHaveBeenCalledTimes(1)
  })

  describe('settled answers expire', () => {
    const TTL = 5 * 60 * 1000
    let now = 0

    beforeEach(() => {
      now = 1_000_000
      vi.spyOn(Date, 'now').mockImplementation(() => now)
    })
    afterEach(() => vi.restoreAllMocks())

    it('a hidden answer is asked again after the TTL, so a deployed gateway shows up without a restart', async () => {
      const getDiscoverOptions = vi.fn().mockRejectedValueOnce(new AcquisitionApiError(404, 'discover_not_supported', 'no')).mockResolvedValueOnce(OPTIONS)
      const wrapper = wrapperFor({ getDiscoverOptions })

      const first = renderHook(() => useDiscoverOptions(), { wrapper })
      await waitFor(() => expect(first.result.current.status).toBe('hidden'))
      first.unmount()

      now += TTL - 1000
      const within = renderHook(() => useDiscoverOptions(), { wrapper })
      expect(within.result.current.status).toBe('hidden')
      expect(getDiscoverOptions).toHaveBeenCalledTimes(1)
      within.unmount()

      now += 2000
      const after = renderHook(() => useDiscoverOptions(), { wrapper })
      expect(after.result.current.status).toBe('loading')
      await waitFor(() => expect(after.result.current.status).toBe('ready'))
      expect(getDiscoverOptions).toHaveBeenCalledTimes(2)
    })

    it('a ready answer expires too, so a removed catalog stops being selectable', async () => {
      const getDiscoverOptions = vi.fn().mockResolvedValueOnce(OPTIONS).mockResolvedValueOnce({ ...OPTIONS, catalogs: [{ id: 'popular', label: 'Popular' }] })
      const wrapper = wrapperFor({ getDiscoverOptions })

      const first = renderHook(() => useDiscoverOptions(), { wrapper })
      await waitFor(() => expect(first.result.current.status).toBe('ready'))
      first.unmount()

      now += TTL + 1
      const after = renderHook(() => useDiscoverOptions(), { wrapper })
      await waitFor(() => expect(after.result.current.options?.catalogs).toHaveLength(1))
      expect(getDiscoverOptions).toHaveBeenCalledTimes(2)
    })

    it('retry() bypasses a still-fresh settled answer instead of handing it back', async () => {
      const getDiscoverOptions = vi.fn().mockRejectedValueOnce(new AcquisitionApiError(404, 'discover_not_supported', 'no')).mockResolvedValueOnce(OPTIONS)
      const { result } = renderHook(() => useDiscoverOptions(), { wrapper: wrapperFor({ getDiscoverOptions }) })
      await waitFor(() => expect(result.current.status).toBe('hidden'))

      act(() => result.current.retry())
      await waitFor(() => expect(result.current.status).toBe('ready'))
      expect(getDiscoverOptions).toHaveBeenCalledTimes(2)
    })
  })

  it('never shows the previous client\'s options after the client is replaced', async () => {
    const oldClient = { getDiscoverOptions: vi.fn().mockResolvedValue(OPTIONS) }
    let release!: (value: DiscoverOptionsResponse) => void
    const newClient = { getDiscoverOptions: vi.fn().mockReturnValue(new Promise<DiscoverOptionsResponse>((resolve) => (release = resolve))) }
    let current: unknown = oldClient
    const renders: Array<ReturnType<typeof useDiscoverOptions>> = []
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
        const value = useDiscoverOptions()
        renders.push(value)
        return value
      },
      { wrapper }
    )
    await waitFor(() => expect(result.current.status).toBe('ready'))

    renders.length = 0
    current = newClient
    rerender()

    expect(renders.length).toBeGreaterThan(0)
    for (const render of renders) {
      expect(render.options).toBeNull()
      expect(render.status).toBe('loading')
    }
    await act(async () => release({ catalogs: [{ id: 'trending', label: 'Trending' }], genres: [] }))
    expect(result.current.options?.catalogs.map((catalog) => catalog.id)).toEqual(['trending'])
  })
})
