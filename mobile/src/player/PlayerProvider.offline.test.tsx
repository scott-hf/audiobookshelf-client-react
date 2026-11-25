import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AbsClient } from '../api/absClient'
import { AuthContext, type AuthContextValue } from '../auth/AuthProvider'
import { PlayerContextValue, PlayerProvider, usePlayer } from './PlayerProvider'

// Force the native branch of PlayerProvider.play().
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
