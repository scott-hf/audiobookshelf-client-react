import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AbsClient } from '../api/absClient'
import { AuthContext, type AuthContextValue } from '../auth/AuthProvider'
import { cacheServerProgress } from './offlineProgress'
import { OFFLINE_REPLAY_STARTUP_DELAY_MS, PlayerContextValue, PlayerProvider, usePlayer } from './PlayerProvider'

// Force the native branch of PlayerProvider.play().
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
  registerPlugin: () => ({})
}))

// Captures the `appStateChange` handler so a test can fire a return to the foreground.
const appState = vi.hoisted(() => ({ handler: null as ((state: { isActive: boolean }) => void) | null }))
vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn((_event: string, handler: (state: { isActive: boolean }) => void) => {
      appState.handler = handler
      return Promise.resolve({ remove: () => Promise.resolve() })
    })
  }
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

// The item IS downloaded, so play() resolves to the offline branch.
vi.mock('../downloads/DownloadProvider', () => ({
  useDownloads: () => ({
    queue: [],
    localItems: [
      {
        libraryItemId: 'b1',
        serverConnectionId: 'https://books.test',
        folderUri: 'file:///data/b1',
        manifestJson: JSON.stringify({ tracks: [{ trackIndex: 0, path: '/data/b1/1.mp3' }] }),
        completedAt: 1
      }
    ],
    pause: vi.fn(),
    resume: vi.fn(),
    cancel: vi.fn(),
    download: vi.fn(),
    isLocal: () => true
  })
}))

const STORAGE_KEY = 'shelfdroid.offlineProgress'

function seedLocal(record: { currentTime: number; unsyncedTimeListened?: number }): void {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ b1: { currentTime: record.currentTime, duration: 3600, unsyncedTimeListened: record.unsyncedTimeListened ?? 0, updatedAt: 1 } })
  )
}

function storedRecord(): { currentTime: number; unsyncedTimeListened: number } | undefined {
  const raw = window.localStorage.getItem(STORAGE_KEY)
  return raw ? (JSON.parse(raw) as Record<string, { currentTime: number; unsyncedTimeListened: number }>).b1 : undefined
}

let player: PlayerContextValue

function Capture() {
  player = usePlayer()
  return (
    <span data-testid="state">
      {player.state.status}:{player.state.currentTime}
    </span>
  )
}

function renderPlayer(client: Partial<AbsClient>) {
  const authValue: AuthContextValue = {
    state: { status: 'authenticated', serverUrl: 'https://books.test' },
    client: {
      closeSession: vi.fn().mockResolvedValue(undefined),
      syncSession: vi.fn().mockResolvedValue(undefined),
      getAccessToken: () => 'token',
      getServerUrl: () => 'https://books.test',
      ...client
    } as unknown as AbsClient,
    acquisitionClient: null,
    login: vi.fn(),
    logout: vi.fn()
  }
  return render(
    <AuthContext.Provider value={authValue}>
      <PlayerProvider>
        <Capture />
      </PlayerProvider>
    </AuthContext.Provider>
  )
}

/** The `currentTime` the offline branch handed to the native player. */
function loadedStartTime(): number {
  return (nativePlugin.load.mock.calls[0][0] as { session: { currentTime: number } }).session.currentTime
}

const serverSession = (currentTime: number) => ({ id: 'srv-session', currentTime, audioTracks: [] })

describe('PlayerProvider offline resume', () => {
  beforeEach(() => {
    window.localStorage.clear()
    for (const mock of Object.values(nativePlugin)) mock.mockReset()
    nativePlugin.load.mockResolvedValue(undefined)
    nativePlugin.play.mockResolvedValue(undefined)
    nativePlugin.stop.mockResolvedValue(undefined)
    nativePlugin.getState.mockResolvedValue({ status: 'idle', itemId: null, currentTime: 0, duration: 0, error: null, rate: 1, playWhenReady: false })
    nativePlugin.addListener.mockResolvedValue({ remove: () => Promise.resolve() })
  })

  afterEach(() => {
    window.localStorage.clear()
  })

  it('resumes from the local record when the server is unreachable', async () => {
    seedLocal({ currentTime: 500 })
    renderPlayer({ startSession: vi.fn().mockRejectedValue(new Error('offline')) })

    await act(async () => {
      await player.play('b1')
    })

    expect(loadedStartTime()).toBe(500)
    // Unsynced fallback derives a session id from the item id, but must never equal it (a recovered
    // session would otherwise be mistaken for "already loaded" by PlayerPage).
    expect((nativePlugin.load.mock.calls[0][0] as { session: { id: string } }).session.id).toBe('offline:b1')
  })

  it('first offline play of a downloaded, never-played book starts at its cached server position', async () => {
    cacheServerProgress('b1', 843, { duration: 3600 })
    renderPlayer({ startSession: vi.fn().mockRejectedValue(new Error('offline')) })

    await act(async () => {
      await player.play('b1')
    })

    expect(loadedStartTime()).toBe(843)
  })

  it('shows the cached server position while loading instead of flashing 0:00', async () => {
    cacheServerProgress('b1', 843, { duration: 3600 })
    renderPlayer({ startSession: vi.fn().mockReturnValue(new Promise(() => undefined)) })

    await act(async () => {
      void player.play('b1')
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(screen.getByTestId('state')).toHaveTextContent('loading:843')
  })

  it('a position listened to offline beats a cached server position', async () => {
    cacheServerProgress('b1', 843, { duration: 3600 })
    seedLocal({ currentTime: 30, unsyncedTimeListened: 20 }) // the listener later played, then rewound
    renderPlayer({ startSession: vi.fn().mockRejectedValue(new Error('offline')) })

    await act(async () => {
      await player.play('b1')
    })

    expect(loadedStartTime()).toBe(30)
  })

  it('a live server position beats the cached snapshot when the server is reachable', async () => {
    cacheServerProgress('b1', 843, { duration: 3600 })
    renderPlayer({ startSession: vi.fn().mockResolvedValue(serverSession(900)) })

    await act(async () => {
      await player.play('b1')
    })

    expect(loadedStartTime()).toBe(900)
  })

  it('starts at 0 with neither a server session nor a local record', async () => {
    renderPlayer({ startSession: vi.fn().mockRejectedValue(new Error('offline')) })
    await act(async () => {
      await player.play('b1')
    })
    expect(loadedStartTime()).toBe(0)
  })

  it('prefers the local position when it is ahead of a stale server (offline listening)', async () => {
    seedLocal({ currentTime: 3_700 })
    renderPlayer({ startSession: vi.fn().mockResolvedValue(serverSession(100)) })
    await act(async () => {
      await player.play('b1')
    })
    expect(loadedStartTime()).toBe(3_700)
  })

  it('prefers the server position when it is ahead of the local record', async () => {
    seedLocal({ currentTime: 500 })
    renderPlayer({ startSession: vi.fn().mockResolvedValue(serverSession(900)) })
    await act(async () => {
      await player.play('b1')
    })
    expect(loadedStartTime()).toBe(900)
  })

  it('uses the server position when there is no local record', async () => {
    renderPlayer({ startSession: vi.fn().mockResolvedValue(serverSession(321)) })
    await act(async () => {
      await player.play('b1')
    })
    expect(loadedStartTime()).toBe(321)
  })

  it('replays unsynced offline progress to the new session once, then zeroes the counter', async () => {
    seedLocal({ currentTime: 3_700, unsyncedTimeListened: 3_600 })
    const syncSession = vi.fn().mockResolvedValue(undefined)
    renderPlayer({ startSession: vi.fn().mockResolvedValue(serverSession(100)), syncSession })

    await act(async () => {
      await player.play('b1')
    })

    expect(syncSession).toHaveBeenCalledTimes(1)
    expect(syncSession).toHaveBeenCalledWith('srv-session', { currentTime: 3_700, timeListened: 3_600 })
    expect(storedRecord()?.unsyncedTimeListened).toBe(0)
    expect(loadedStartTime()).toBe(3_700)
  })

  it('a failed replay does not break playback and keeps the counter for a retry', async () => {
    seedLocal({ currentTime: 3_700, unsyncedTimeListened: 60 })
    const syncSession = vi.fn().mockRejectedValue(new Error('flaky'))
    renderPlayer({ startSession: vi.fn().mockResolvedValue(serverSession(100)), syncSession })

    await act(async () => {
      await player.play('b1')
    })

    expect(nativePlugin.play).toHaveBeenCalledTimes(1)
    expect(loadedStartTime()).toBe(3_700)
    expect(storedRecord()?.unsyncedTimeListened).toBe(60)
  })

  it('shows the resume position immediately while the session request is still in flight', async () => {
    seedLocal({ currentTime: 500 })
    // Never resolves: the provider stays in `loading`, which is exactly the window being checked.
    renderPlayer({ startSession: vi.fn().mockReturnValue(new Promise(() => undefined)) })

    await act(async () => {
      void player.play('b1')
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(screen.getByTestId('state')).toHaveTextContent('loading:500')
  })
})

describe('PlayerProvider replays stranded offline progress without waiting for a play', () => {
  const record = (currentTime: number, unsyncedTimeListened: number, extra: Record<string, unknown> = {}) => ({
    currentTime,
    duration: 3600,
    unsyncedTimeListened,
    updatedAt: 1,
    ...extra
  })

  function seedAll(records: Record<string, ReturnType<typeof record>>): void {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records))
  }

  function storedAll(): Record<string, { currentTime: number; unsyncedTimeListened: number; source?: string }> {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, { currentTime: number; unsyncedTimeListened: number; source?: string }>
  }

  /** The server's position per item when a session is opened for it. */
  function sessions(positions: Record<string, number> = {}) {
    return vi.fn(async (id: string) => ({ id: `sess-${id}`, currentTime: positions[id] ?? 0, audioTracks: [] }))
  }

  beforeEach(() => {
    appState.handler = null
    window.localStorage.clear()
    for (const mock of Object.values(nativePlugin)) mock.mockReset()
    nativePlugin.load.mockResolvedValue(undefined)
    nativePlugin.play.mockResolvedValue(undefined)
    nativePlugin.stop.mockResolvedValue(undefined)
    nativePlugin.getState.mockResolvedValue({ status: 'idle', itemId: null, currentTime: 0, duration: 0, error: null, rate: 1, playWhenReady: false })
    nativePlugin.addListener.mockResolvedValue({ remove: () => Promise.resolve() })
  })

  afterEach(() => {
    vi.useRealTimers()
    window.localStorage.clear()
  })

  it('pushes every stranded book when the network returns, with nothing playing, and never a server-cache snapshot', async () => {
    seedAll({
      b1: record(3_700, 3_600),
      b2: record(900, 120),
      snapshot: record(843, 0, { source: 'server-cache' }),
      behind: record(100, 40)
    })
    const startSession = sessions({ behind: 500 })
    const closeSession = vi.fn().mockResolvedValue(undefined)
    renderPlayer({ startSession, closeSession })

    await act(async () => {
      window.dispatchEvent(new Event('online'))
    })

    await vi.waitFor(() => expect(storedAll().b1.unsyncedTimeListened).toBe(0))
    expect(closeSession).toHaveBeenCalledWith('sess-b1', { currentTime: 3_700, timeListened: 3_600 })
    expect(closeSession).toHaveBeenCalledWith('sess-b2', { currentTime: 900, timeListened: 120 })
    expect(storedAll().b2.unsyncedTimeListened).toBe(0)
    // The snapshot is never even asked about; the behind-the-server record is probed but sends no listening.
    expect(startSession.mock.calls.map((call) => call[0]).sort()).toEqual(['b1', 'b2', 'behind'])
    expect(closeSession).toHaveBeenCalledWith('sess-behind', { currentTime: 500, timeListened: 0 })
    expect(storedAll().snapshot).toMatchObject({ currentTime: 843, unsyncedTimeListened: 0, source: 'server-cache' })

    // A second reconnect finds nothing left: no double count.
    const closesBefore = closeSession.mock.calls.length
    await act(async () => {
      window.dispatchEvent(new Event('online'))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(closeSession.mock.calls.length).toBe(closesBefore)
    expect(startSession).toHaveBeenCalledTimes(3)
  })

  it('also replays when the app returns to the foreground', async () => {
    seedAll({ b2: record(900, 120) })
    const closeSession = vi.fn().mockResolvedValue(undefined)
    renderPlayer({ startSession: sessions(), closeSession })

    await act(async () => {
      appState.handler?.({ isActive: true })
    })

    await vi.waitFor(() => expect(closeSession).toHaveBeenCalledWith('sess-b2', { currentTime: 900, timeListened: 120 }))
    expect(storedAll().b2.unsyncedTimeListened).toBe(0)
  })

  it('replays shortly after launch, not before, so a cold start with stranded progress catches up', async () => {
    vi.useFakeTimers()
    seedAll({ b2: record(900, 120) })
    const startSession = sessions()
    renderPlayer({ startSession, closeSession: vi.fn().mockResolvedValue(undefined) })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(OFFLINE_REPLAY_STARTUP_DELAY_MS - 1)
    })
    expect(startSession).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(startSession).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(storedAll().b2.unsyncedTimeListened).toBe(0))
  })

  it('leaves the book being played to its own sync, replays the others, and picks the book up once it is closed', async () => {
    seedLocal({ currentTime: 3_700, unsyncedTimeListened: 3_600 })
    let started = 0
    const startSession = vi.fn(async (id: string) => ({ id: started++ === 0 ? 'srv-session' : `sess-${id}`, currentTime: 100, audioTracks: [] }))
    const syncSession = vi.fn().mockResolvedValue(undefined)
    const closeSession = vi.fn().mockResolvedValue(undefined)
    renderPlayer({ startSession, syncSession, closeSession })

    await act(async () => {
      await player.play('b1') // its own replay at session start pushes the 3 600 s once
    })
    expect(syncSession).toHaveBeenCalledTimes(1)

    // More listening for b1 lands in the store while it is loading/playing, and b2 is stranded too.
    seedAll({ b1: record(3_800, 50), b2: record(900, 120) })
    await act(async () => {
      window.dispatchEvent(new Event('online'))
    })
    await vi.waitFor(() => expect(storedAll().b2.unsyncedTimeListened).toBe(0))

    expect(startSession.mock.calls.map((call) => call[0])).toEqual(['b1', 'b2']) // no second session for b1
    expect(storedAll().b1.unsyncedTimeListened).toBe(50)
    expect(syncSession).toHaveBeenCalledTimes(1)

    // Closing releases it: it is no longer the live player's, so it is delivered.
    await act(async () => {
      await player.close()
    })
    await vi.waitFor(() => expect(closeSession).toHaveBeenCalledWith('sess-b1', { currentTime: 3_800, timeListened: 50 }))
    expect(storedAll().b1.unsyncedTimeListened).toBe(0)
  })
})
