import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AbsClient } from '../api/absClient'
import { AuthContext, type AuthContextValue } from '../auth/AuthProvider'
import { LOADING_TIMEOUT_MS, PlayerProvider, STALL_THRESHOLD_MS } from '../player/PlayerProvider'
import type { NativePlayerState } from '../player/playerTypes'
import { withClientDefaults } from '../test/absClientMock'
import PlayerPage from './PlayerPage'

// Force the native branch of PlayerProvider.
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
  registerPlugin: () => ({})
}))

vi.mock('@capacitor/app', () => ({
  App: { addListener: vi.fn().mockResolvedValue({ remove: () => Promise.resolve() }) }
}))

const nativePlugin = vi.hoisted(() => ({
  load: vi.fn(),
  play: vi.fn(),
  pause: vi.fn(),
  seek: vi.fn(),
  setRate: vi.fn(),
  stop: vi.fn(),
  setSleepTimer: vi.fn(),
  getState: vi.fn(),
  addListener: vi.fn()
}))

vi.mock('../native/absAudioPlayerPlugin', () => ({ default: nativePlugin }))
vi.mock('../native/castPlugin', () => ({
  default: {
    addListener: vi.fn().mockResolvedValue({ remove: () => Promise.resolve() }),
    load: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockResolvedValue({ connected: false })
  }
}))

const downloadedItems = vi.hoisted(() => ({ localItems: [] as Array<Record<string, unknown>> }))

vi.mock('../downloads/DownloadProvider', () => ({
  useDownloads: () => ({ queue: [], localItems: downloadedItems.localItems, pause: vi.fn(), resume: vi.fn(), cancel: vi.fn(), download: vi.fn(), isLocal: () => false })
}))

type SessionResult = { id: string; currentTime: number; audioTracks: Array<{ index: number; contentUrl: string; duration: number }> }

function makeSession(id = 's1'): SessionResult {
  return { id, currentTime: 0, audioTracks: [{ index: 0, contentUrl: '/api/items/b1/file/f1', duration: 3600 }] }
}

/** Pushes a native `playerState` event through whichever listener the provider registered. */
function emit(state: Partial<NativePlayerState> & Pick<NativePlayerState, 'state'>): void {
  const call = nativePlugin.addListener.mock.calls.filter(([event]) => event === 'playerState').at(-1)
  if (!call) throw new Error('no playerState listener registered')
  const listener = call[1] as (state: NativePlayerState) => void
  act(() => {
    listener({ currentTime: 0, duration: 3600, playbackRate: 1, playWhenReady: false, ...state })
  })
}

function renderPlayer(startSession: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(makeSession())) {
  const client = withClientDefaults({
    startSession,
    closeSession: vi.fn().mockResolvedValue(undefined),
    syncSession: vi.fn().mockResolvedValue(undefined),
    getLibraryItem: vi.fn().mockRejectedValue(new Error('offline'))
  } as unknown as Partial<AbsClient>)
  const authValue: AuthContextValue = {
    state: { status: 'authenticated', serverUrl: 'https://books.test' },
    client,
    acquisitionClient: null,
    login: vi.fn(),
    logout: vi.fn()
  }
  render(
    <AuthContext.Provider value={authValue}>
      <PlayerProvider>
        <MemoryRouter initialEntries={['/player/b1']}>
          <Routes>
            <Route path="/player/:itemId" element={<PlayerPage />} />
          </Routes>
        </MemoryRouter>
      </PlayerProvider>
    </AuthContext.Provider>
  )
  return { startSession }
}

/** Waits for play() to finish loading, then reports native buffering/playing like ExoPlayer would. */
async function settleLoaded() {
  await waitFor(() => expect(nativePlugin.play).toHaveBeenCalled())
  nativePlugin.play.mockClear()
}

beforeEach(() => {
  vi.clearAllMocks()
  downloadedItems.localItems = []
  nativePlugin.load.mockResolvedValue(undefined)
  nativePlugin.play.mockResolvedValue(undefined)
  nativePlugin.pause.mockResolvedValue(undefined)
  nativePlugin.seek.mockResolvedValue(undefined)
  nativePlugin.setRate.mockResolvedValue(undefined)
  nativePlugin.stop.mockResolvedValue(undefined)
  nativePlugin.setSleepTimer.mockResolvedValue(undefined)
  nativePlugin.getState.mockResolvedValue({ status: 'idle', itemId: null, currentTime: 0, duration: 0, error: null, rate: 1, playWhenReady: false })
  nativePlugin.addListener.mockResolvedValue({ remove: () => Promise.resolve() })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('PlayerPage offline metadata fallback', () => {
  it('shows the downloaded manifest title, author and local cover when the server item is unreachable', async () => {
    downloadedItems.localItems = [
      {
        libraryItemId: 'b1',
        serverConnectionId: 'https://books.test',
        folderUri: '/d/b1',
        manifestJson: JSON.stringify({ title: 'Offline Title', author: 'Offline Author', coverPath: '/d/b1/cover.jpg', tracks: [{ trackIndex: 0, path: '/d/b1/a.mp3', duration: 3600 }] }),
        completedAt: 1
      }
    ]
    renderPlayer()
    expect(await screen.findByRole('heading', { name: 'Offline Title' })).toBeInTheDocument()
    expect(screen.getByText('Offline Author')).toBeInTheDocument()
    expect(document.querySelector('img')?.getAttribute('src')).toContain('/d/b1/cover.jpg')
  })
})

describe('PlayerPage transport controls (native)', () => {
  it('shows Pause and a spinner while buffering with intent to play, and a tap pauses', async () => {
    const user = userEvent.setup()
    renderPlayer()
    await settleLoaded()

    emit({ state: 'buffering', currentTime: 12, playWhenReady: true })

    const button = await screen.findByRole('button', { name: 'Pause' })
    expect(button).toBeEnabled()
    expect(screen.getByTestId('player-spinner')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Play' })).not.toBeInTheDocument()

    await user.click(button)

    expect(nativePlugin.pause).toHaveBeenCalledTimes(1)
    expect(nativePlugin.play).not.toHaveBeenCalled()
    // Optimistic: the button flips to Play immediately, before any native event confirms it.
    expect(await screen.findByRole('button', { name: 'Play' })).toBeEnabled()
    expect(screen.getByTestId('player-spinner')).toBeInTheDocument()

    // Reconciles on the next native event.
    emit({ state: 'buffering', currentTime: 12, playWhenReady: false })
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument()
  })

  it('shows an enabled Play button while buffering without intent to play, and a tap plays', async () => {
    const user = userEvent.setup()
    renderPlayer()
    await settleLoaded()

    emit({ state: 'buffering', playWhenReady: false })
    const button = await screen.findByRole('button', { name: 'Play' })
    expect(button).toBeEnabled()

    await user.click(button)
    expect(nativePlugin.play).toHaveBeenCalledTimes(1)
    expect(await screen.findByRole('button', { name: 'Pause' })).toBeInTheDocument()
  })

  it('restarts from the Play button after playback ended', async () => {
    const user = userEvent.setup()
    renderPlayer()
    await settleLoaded()

    emit({ state: 'ended', currentTime: 3600 })
    await user.click(await screen.findByRole('button', { name: 'Play' }))

    // The native play() handles STATE_ENDED (seek to 0) -- JS must still just ask it to play.
    expect(nativePlugin.play).toHaveBeenCalledTimes(1)
  })

  it('offers Retry from the error state and re-runs play(itemId) with a fresh session', async () => {
    const user = userEvent.setup()
    const startSession = vi.fn().mockResolvedValueOnce(makeSession('s1')).mockResolvedValueOnce(makeSession('s2'))
    renderPlayer(startSession)
    await settleLoaded()

    emit({ state: 'error', error: 'Source error' })
    expect(await screen.findByRole('alert')).toHaveTextContent('Source error')

    await user.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(startSession).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(nativePlugin.load).toHaveBeenCalledTimes(2))
    expect(nativePlugin.load.mock.calls[1][0].session.id).toBe('s2')
  })

  it('surfaces a rejected plugin call instead of swallowing it, and restores the button', async () => {
    const user = userEvent.setup()
    renderPlayer()
    await settleLoaded()

    emit({ state: 'playing', currentTime: 5, playWhenReady: true })
    nativePlugin.pause.mockRejectedValueOnce(new Error('Native player service not bound yet'))

    await user.click(await screen.findByRole('button', { name: 'Pause' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Native player service not bound yet')
    // The optimistic flip was reverted: playback is still going.
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument()
  })

  it('surfaces a rejected play() from the Play button', async () => {
    const user = userEvent.setup()
    renderPlayer()
    await settleLoaded()

    emit({ state: 'paused', currentTime: 5, playWhenReady: false })
    nativePlugin.play.mockRejectedValueOnce({ message: 'Native player service not bound yet' })

    await user.click(await screen.findByRole('button', { name: 'Play' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Native player service not bound yet')
  })

  it('jumps relative to the latest native position, not a stale one', async () => {
    const user = userEvent.setup()
    renderPlayer()
    await settleLoaded()

    emit({ state: 'playing', currentTime: 0, playWhenReady: true })
    // Ten minutes of playback arrive as position ticks with no state change.
    emit({ state: 'playing', currentTime: 300, playWhenReady: true })
    emit({ state: 'playing', currentTime: 600, playWhenReady: true })

    await user.click(screen.getByRole('button', { name: 'Jump forward' }))
    expect(nativePlugin.seek).toHaveBeenLastCalledWith({ seconds: 630 })

    // Back-to-back jumps build on the optimistic position rather than the last native snapshot.
    await user.click(screen.getByRole('button', { name: 'Jump forward' }))
    expect(nativePlugin.seek).toHaveBeenLastCalledWith({ seconds: 660 })

    await user.click(screen.getByRole('button', { name: 'Jump backward' }))
    expect(nativePlugin.seek).toHaveBeenLastCalledWith({ seconds: 650 })
  })
})

// jsdom does no layout, so these pin the STRUCTURE the "controls visible without scrolling" fix
// relies on (a non-scrolling, non-shrinking controls dock beside a self-scrolling info region),
// not any pixel position. Whether the controls actually land on screen is a device check.
describe('PlayerPage layout (structural guarantees)', () => {
  const SCROLLING = /(^|\s)overflow(-y)?-(auto|scroll|hidden)(\s|$)/

  function ancestorsOf(element: HTMLElement): HTMLElement[] {
    const chain: HTMLElement[] = []
    for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) chain.push(node)
    return chain
  }

  it('renders every transport control inside a shrink-0 dock that has no scrolling ancestor', async () => {
    renderPlayer()
    await settleLoaded()
    emit({ state: 'playing', currentTime: 65, duration: 3600, playWhenReady: true })

    const dock = screen.getByTestId('player-controls')
    expect(dock.className).toContain('shrink-0')

    for (const control of [
      screen.getByRole('button', { name: 'Pause' }),
      screen.getByRole('button', { name: 'Jump backward' }),
      screen.getByRole('button', { name: 'Jump forward' }),
      screen.getByRole('slider', { name: 'Seek' }),
      screen.getByText('1:05'),
      screen.getByText('1:00:00')
    ]) {
      expect(dock).toContainElement(control)
    }

    // Neither the dock nor anything above it may scroll or clip it: the controls must not be able
    // to move out of view by scrolling a region they sit in.
    for (const node of [dock, ...ancestorsOf(dock)]) expect(node.className).not.toMatch(SCROLLING)
  })

  it('keeps the cover and metadata in a separate self-scrolling region that does not contain the controls', async () => {
    downloadedItems.localItems = [
      {
        libraryItemId: 'b1',
        serverConnectionId: 'https://books.test',
        folderUri: '/d/b1',
        manifestJson: JSON.stringify({ title: 'Long Book', author: 'An Author', coverPath: '/d/b1/cover.jpg', tracks: [{ trackIndex: 0, path: '/d/b1/a.mp3', duration: 3600 }] }),
        completedAt: 1
      }
    ]
    renderPlayer()
    const heading = await screen.findByRole('heading', { name: 'Long Book' })

    const info = screen.getByTestId('player-info')
    const dock = screen.getByTestId('player-controls')
    expect(info.className).toMatch(/overflow-y-auto/)
    expect(info.className).toContain('min-h-0')
    expect(info.className).toContain('flex-1')
    expect(info).toContainElement(heading)
    expect(info).toContainElement(screen.getByText('An Author'))
    expect(info).toContainElement(document.querySelector('img'))
    expect(info).not.toContainElement(dock)
    expect(dock).not.toContainElement(info)

    // Siblings under one flex-column root, info first, so the dock is the bottom-most item and
    // the root fills the shell's scroll area (h-full) with a floor (min-h-*) below which the
    // shell's own scrolling takes over instead of clipping the dock.
    const root = info.parentElement as HTMLElement
    expect(dock.parentElement).toBe(root)
    expect(Array.from(root.children)).toEqual([info, dock])
    expect(root.className).toContain('flex-col')
    expect(root.className).toContain('h-full')
    expect(root.className).toMatch(/min-h-\[/)
  })

  it('caps the cover height by the viewport rather than its width', async () => {
    renderPlayer()
    await settleLoaded()
    const coverFrame = screen.getByTestId('player-info').firstElementChild as HTMLElement
    expect(coverFrame.className).toMatch(/h-\[min\(\d+dvh,/)
    expect(coverFrame.className).toContain('shrink-0')
  })

  it('keeps an error and its Retry button inside the dock so both stay on screen together', async () => {
    renderPlayer()
    await settleLoaded()
    emit({ state: 'error', error: 'Source error' })

    const dock = screen.getByTestId('player-controls')
    expect(dock).toContainElement(await screen.findByRole('alert'))
    expect(dock).toContainElement(screen.getByRole('button', { name: 'Retry' }))
  })
})

describe('PlayerPage watchdogs (native)', () => {
  it('reports a stall once buffering with intent to play outlasts the threshold', async () => {
    renderPlayer()
    await settleLoaded()

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    emit({ state: 'buffering', playWhenReady: true })
    expect(screen.getByText('Buffering…')).toBeInTheDocument()

    // Position ticks while buffering must not restart the clock.
    act(() => {
      vi.advanceTimersByTime(STALL_THRESHOLD_MS - 1_000)
    })
    emit({ state: 'buffering', currentTime: 1, playWhenReady: true })
    act(() => {
      vi.advanceTimersByTime(1_000)
    })

    expect(screen.getByText('Still buffering. Check your connection.')).toBeInTheDocument()

    emit({ state: 'playing', currentTime: 2, playWhenReady: true })
    expect(screen.getByText('Playing')).toBeInTheDocument()
  })

  it('turns a hung session request into an error with a retry path', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const startSession = vi.fn().mockReturnValue(new Promise(() => {}))
    renderPlayer(startSession)

    await act(async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve()
    })
    expect(screen.getByText('Loading…')).toBeInTheDocument()

    await act(async () => {
      vi.advanceTimersByTime(LOADING_TIMEOUT_MS + 1)
      await Promise.resolve()
    })

    expect(screen.getByRole('alert')).toHaveTextContent('Loading took too long')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled()
  })
})
