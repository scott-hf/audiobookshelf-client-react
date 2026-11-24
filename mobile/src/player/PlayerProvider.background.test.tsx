import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AbsClient } from '../api/absClient'
import { AuthContext, type AuthContextValue } from '../auth/AuthProvider'
import type { NativePlayerState, PlayerSnapshot } from './playerTypes'
import { PlayerContextValue, PlayerProvider, usePlayer } from './PlayerProvider'

// Force the native branch of PlayerProvider.
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
  registerPlugin: () => ({})
}))

// Captures the `appStateChange` handler so a test can fire background/foreground transitions.
const appState = vi.hoisted(() => ({ handler: null as ((state: { isActive: boolean }) => void) | null }))
vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn((_event: string, handler: (state: { isActive: boolean }) => void) => {
      appState.handler = handler
      return Promise.resolve({ remove: () => Promise.resolve() })
    })
  }
}))

// Captures the native `playerState` listener so a test can push snapshots the way the service does.
const nativeEvents = vi.hoisted(() => ({ emit: null as ((state: NativePlayerState) => void) | null }))
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

// No local downloads -- exercise the streaming path.
vi.mock('../downloads/DownloadProvider', () => ({
  useDownloads: () => ({ queue: [], localItems: [], pause: vi.fn(), resume: vi.fn(), cancel: vi.fn(), download: vi.fn(), isLocal: () => false })
}))

const IDLE: PlayerSnapshot = { status: 'idle', itemId: null, currentTime: 0, duration: 0, error: null, rate: 1, playWhenReady: false }

let player: PlayerContextValue
let client: { startSession: ReturnType<typeof vi.fn>; syncSession: ReturnType<typeof vi.fn>; closeSession: ReturnType<typeof vi.fn> }

function Capture() {
  player = usePlayer()
  return (
    <span data-testid="state">
      {player.state.status}:{player.state.currentTime}
    </span>
  )
}

function renderPlayer() {
  client = {
    startSession: vi.fn().mockResolvedValue({ id: 'srv-session', currentTime: 0, audioTracks: [{ index: 0, contentUrl: '/api/items/b1/file/f1', duration: 3600 }] }),
    syncSession: vi.fn().mockResolvedValue(undefined),
    closeSession: vi.fn().mockResolvedValue(undefined)
  }
  const authValue: AuthContextValue = {
    state: { status: 'authenticated', serverUrl: 'https://books.test' },
    client: { ...client, getAccessToken: () => 'token', getServerUrl: () => 'https://books.test' } as unknown as AbsClient,
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

/** A native `playerState` event, as the service's 500 ms ticker would emit it. */
function nativeTick(state: NativePlayerState['state'], currentTime: number): NativePlayerState {
  return { state, currentTime, duration: 3600, playbackRate: 1, playWhenReady: state === 'playing' }
}

async function startPlaying(currentTime = 10): Promise<void> {
  await act(async () => {
    await player.play('b1')
  })
  act(() => nativeEvents.emit?.(nativeTick('playing', currentTime)))
  expect(screen.getByTestId('state').textContent).toBe(`playing:${currentTime}`)
}

async function setActive(isActive: boolean): Promise<void> {
  await act(async () => {
    appState.handler?.({ isActive })
    // Let the getState() round trip and the state update it triggers settle.
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
}

describe('PlayerProvider app background / foreground', () => {
  beforeEach(() => {
    appState.handler = null
    nativeEvents.emit = null
    for (const mock of Object.values(nativePlugin)) mock.mockReset()
    nativePlugin.load.mockResolvedValue(undefined)
    nativePlugin.play.mockResolvedValue(undefined)
    nativePlugin.stop.mockResolvedValue(undefined)
    nativePlugin.getState.mockResolvedValue(IDLE)
    nativePlugin.addListener.mockImplementation((_event: string, listener: (state: NativePlayerState) => void) => {
      nativeEvents.emit = listener
      return Promise.resolve({ remove: () => Promise.resolve() })
    })
  })

  it('keeps playing when backgrounded: does not stop the native player or close the session', async () => {
    renderPlayer()
    await startPlaying(10)
    const stopCallsBefore = nativePlugin.stop.mock.calls.length

    await setActive(false)

    expect(nativePlugin.stop.mock.calls.length).toBe(stopCallsBefore)
    expect(client.closeSession).not.toHaveBeenCalled()
    expect(screen.getByTestId('state').textContent).toBe('playing:10')
  })

  it('flushes progress to the server when backgrounded, without closing the session', async () => {
    renderPlayer()
    await startPlaying(10)
    expect(client.syncSession).not.toHaveBeenCalled()

    await setActive(false)

    expect(client.syncSession).toHaveBeenCalledTimes(1)
    expect(client.syncSession).toHaveBeenCalledWith('srv-session', expect.objectContaining({ currentTime: 10 }))
    expect(client.closeSession).not.toHaveBeenCalled()
  })

  it('backgrounding with nothing loaded is a harmless no-op', async () => {
    renderPlayer()
    await setActive(false)
    expect(client.syncSession).not.toHaveBeenCalled()
    expect(nativePlugin.stop).not.toHaveBeenCalled()
  })

  it('resyncs the UI from native state when the app returns to the foreground', async () => {
    renderPlayer()
    await startPlaying(10)
    await setActive(false)

    // While away the WebView missed ~8 minutes of ticks; native kept playing.
    nativePlugin.getState.mockResolvedValue({ ...IDLE, status: 'playing', itemId: 'srv-session', currentTime: 490, duration: 3600, playWhenReady: true })
    await setActive(true)

    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('playing:490'))
    expect(nativePlugin.getState).toHaveBeenCalled()
    // The UI keeps the JS item id, not native's session id.
    expect(player.state.itemId).toBe('b1')
    expect(client.closeSession).not.toHaveBeenCalled()
  })

  it('picks up a pause that happened natively while backgrounded (e.g. the sleep timer)', async () => {
    renderPlayer()
    await startPlaying(10)
    await setActive(false)
    client.syncSession.mockClear()

    nativePlugin.getState.mockResolvedValue({ ...IDLE, status: 'paused', itemId: 'srv-session', currentTime: 300, duration: 3600, playWhenReady: false })
    await setActive(true)

    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('paused:300'))
    expect(player.state.playWhenReady).toBe(false)
    // The progress sync saw the paused snapshot, so it reported the position it had missed.
    expect(client.syncSession).toHaveBeenCalledWith('srv-session', expect.objectContaining({ currentTime: 300 }))
  })

  it('does not wipe the UI when native reports idle or nothing is loaded on the JS side', async () => {
    renderPlayer()
    // Nothing loaded: a native snapshot must not conjure a player state out of thin air.
    nativePlugin.getState.mockResolvedValue({ ...IDLE, status: 'playing', itemId: 'srv-session', currentTime: 77, duration: 3600, playWhenReady: true })
    await setActive(true)
    expect(screen.getByTestId('state').textContent).toBe('idle:0')

    await startPlaying(10)
    nativePlugin.getState.mockResolvedValue(IDLE)
    await setActive(true)
    expect(screen.getByTestId('state').textContent).toBe('playing:10')
  })

  it('survives getState() rejecting on return (service not bound)', async () => {
    renderPlayer()
    await startPlaying(10)
    nativePlugin.getState.mockRejectedValue(new Error('Native player service not bound yet'))
    await setActive(true)
    expect(screen.getByTestId('state').textContent).toBe('playing:10')
  })

  it('an item replacement asks native to keep its foreground service; an explicit close does not', async () => {
    renderPlayer()
    await startPlaying(10)
    // play() tore down whatever was there to load b1: another load follows, so keep the foreground.
    expect(nativePlugin.stop).toHaveBeenCalledWith({ keepForeground: true })

    await act(async () => {
      await player.close()
    })
    // Explicit close: plain stop(), so native leaves the foreground and removes the notification.
    expect(nativePlugin.stop).toHaveBeenLastCalledWith()
    expect(client.closeSession).toHaveBeenCalledTimes(1)
  })
})
