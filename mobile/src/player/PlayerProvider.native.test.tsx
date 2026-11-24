import { render, screen } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { AbsClient } from '../api/absClient'
import { AuthContext, type AuthContextValue } from '../auth/AuthProvider'
import { PlayerProvider, usePlayer } from './PlayerProvider'

// Force the native branch of PlayerProvider.play().
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
  registerPlugin: () => ({})
}))

vi.mock('@capacitor/app', () => ({
  App: { addListener: vi.fn().mockResolvedValue({ remove: () => Promise.resolve() }) }
}))

// vi.mock factories are hoisted above module scope, so the plugin double has to be created
// inside vi.hoisted() to exist by the time the factory runs.
const nativePlugin = vi.hoisted(() => ({
  load: vi.fn().mockResolvedValue(undefined),
  play: vi.fn().mockResolvedValue(undefined),
  pause: vi.fn().mockResolvedValue(undefined),
  seek: vi.fn().mockResolvedValue(undefined),
  setRate: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  setSleepTimer: vi.fn().mockResolvedValue(undefined),
  getState: vi.fn().mockResolvedValue({ status: 'idle', itemId: null, currentTime: 0, duration: 0, error: null, rate: 1, playWhenReady: false }),
  addListener: vi.fn().mockResolvedValue({ remove: () => Promise.resolve() })
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

/** Fires two overlapping play() calls for the same item, the way React StrictMode's
 * double-invoked effect does in PlayerPage. */
function DoublePlay({ itemId }: { itemId: string }) {
  const { play } = usePlayer()
  const fired = useRef(false)
  useEffect(() => {
    if (fired.current) return
    fired.current = true
    void play(itemId)
    void play(itemId)
  }, [play, itemId])
  return <span data-testid="ready">ready</span>
}

describe('PlayerProvider native path', () => {
  it('does not leak an ABS session when play() is re-entered before the session resolves', async () => {
    const sessions = ['s1', 's2', 's3']
    let issued = 0
    const startSession = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ id: sessions[issued++], currentTime: 0, audioTracks: [{ index: 0, contentUrl: '/api/items/b1/file/f1', duration: 3600 }] }),
            0
          )
        )
    )
    const closeSession = vi.fn().mockResolvedValue(undefined)

    const client = {
      startSession,
      closeSession,
      syncSession: vi.fn().mockResolvedValue(undefined),
      getAccessToken: () => 'token',
      getServerUrl: () => 'https://books.test',
      authorizedStreamUrl: (u: string) => `https://books.test${u}`
    } as unknown as AbsClient

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
          <DoublePlay itemId="b1" />
        </PlayerProvider>
      </AuthContext.Provider>
    )
    await screen.findByTestId('ready')
    // Let both play() chains settle.
    await new Promise((r) => setTimeout(r, 50))

    // Every session that was opened must also have been closed -- before the fix the first
    // play()'s session was dropped when progressSyncRef was overwritten, and stayed open.
    const opened = startSession.mock.calls.length
    const closed = new Set(closeSession.mock.calls.map((call) => call[0] as string))
    const stillOpen = sessions.slice(0, opened).filter((id) => !closed.has(id))

    // The surviving attempt keeps exactly one session open for playback.
    expect(stillOpen).toHaveLength(1)
  })
})
