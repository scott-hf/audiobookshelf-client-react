import { act, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AbsClient } from '../api/absClient'
import { AuthContext, type AuthContextValue } from '../auth/AuthProvider'
import { withClientDefaults } from '../test/absClientMock'
import type { AbsUserMediaProgress } from '../types/abs'
import { useUserProgress, UserProgressProvider, type UserProgressContextValue } from './UserProgressProvider'

function row(libraryItemId: string, progress: number, episodeId: string | null = null): AbsUserMediaProgress {
  return { id: `mp-${libraryItemId}-${episodeId}`, libraryItemId, episodeId, progress, currentTime: progress * 100, duration: 100, isFinished: progress >= 1 }
}

function user(...mediaProgress: AbsUserMediaProgress[]) {
  return { id: 'u1', username: 'tester', mediaProgress }
}

/** Renders the provider and exposes the live hook value to assertions. */
function mount(client: Partial<AbsClient>) {
  const latest: { current: UserProgressContextValue | null } = { current: null }
  function Probe() {
    latest.current = useUserProgress()
    return <span data-testid="status">{latest.current.status}</span>
  }
  const authValue: AuthContextValue = {
    state: { status: 'authenticated', serverUrl: 'https://books.test' },
    client: withClientDefaults(client),
    acquisitionClient: null,
    login: vi.fn(),
    logout: vi.fn()
  }
  render(
    <AuthContext.Provider value={authValue}>
      <UserProgressProvider>
        <Probe />
      </UserProgressProvider>
    </AuthContext.Provider>
  )
  return latest
}

describe('UserProgressProvider', () => {
  it('fetches /api/me once on mount and resolves books and episodes from the map', async () => {
    const getMe = vi.fn().mockResolvedValue(user(row('li_1', 0.5), row('li_2', 0.25, 'ep_1')))
    const latest = mount({ getMe })

    expect(screen.getByTestId('status')).toHaveTextContent('loading')
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'))

    expect(getMe).toHaveBeenCalledTimes(1)
    expect(latest.current?.getProgress('li_1')?.progress).toBe(0.5)
    expect(latest.current?.getProgress('li_2', 'ep_1')?.progress).toBe(0.25)
    expect(latest.current?.getProgress('li_2')).toBeUndefined()
    expect(latest.current?.getProgress('never-played')).toBeUndefined()
  })

  it('refresh() re-fetches and shows progress made since', async () => {
    const getMe = vi.fn().mockResolvedValueOnce(user(row('li_1', 0.1))).mockResolvedValueOnce(user(row('li_1', 0.9)))
    const latest = mount({ getMe })
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'))

    await act(() => latest.current!.refresh())

    expect(getMe).toHaveBeenCalledTimes(2)
    expect(latest.current?.getProgress('li_1')?.progress).toBe(0.9)
  })

  it('shares one request between concurrent refresh() calls', async () => {
    let resolve!: (value: ReturnType<typeof user>) => void
    const getMe = vi.fn().mockImplementation(() => new Promise((r) => (resolve = r)))
    const latest = mount({ getMe })

    const [first, second] = [latest.current!.refresh(), latest.current!.refresh()]
    expect(getMe).toHaveBeenCalledTimes(1)
    await act(async () => {
      resolve(user(row('li_1', 0.3)))
      await Promise.all([first, second])
    })
    expect(latest.current?.getProgress('li_1')?.progress).toBe(0.3)
  })

  it('reports error but never throws when the first fetch fails', async () => {
    const latest = mount({ getMe: vi.fn().mockRejectedValue(new Error('offline')) })
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('error'))
    expect(latest.current?.progressMap.size).toBe(0)
    expect(latest.current?.getProgress('li_1')).toBeUndefined()
  })

  it('keeps the previous map when a later refresh fails', async () => {
    const getMe = vi.fn().mockResolvedValueOnce(user(row('li_1', 0.6))).mockRejectedValueOnce(new Error('offline'))
    const latest = mount({ getMe })
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'))

    await act(() => latest.current!.refresh())

    expect(screen.getByTestId('status')).toHaveTextContent('error')
    expect(latest.current?.getProgress('li_1')?.progress).toBe(0.6)
  })

  it('throws a clear error when used outside a provider', () => {
    function Orphan() {
      useUserProgress()
      return null
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(() => render(<Orphan />)).toThrow('useUserProgress must be used within a UserProgressProvider')
    spy.mockRestore()
  })
})
