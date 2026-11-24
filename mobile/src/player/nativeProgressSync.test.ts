import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AbsClient } from '../api/absClient'
import type { PlayerSnapshot } from './playerTypes'
import { createNativeProgressSync } from './nativeProgressSync'

function snapshot(overrides: Partial<PlayerSnapshot> = {}): PlayerSnapshot {
  return { status: 'playing', itemId: 'b1', currentTime: 0, duration: 3600, error: null, rate: 1, playWhenReady: true, ...overrides }
}

function fakeApi(): AbsClient {
  return {
    getLibraries: vi.fn(),
    getLibraryItems: vi.fn(),
    getLibraryItem: vi.fn(),
    startSession: vi.fn(),
    syncSession: vi.fn().mockResolvedValue(undefined),
    closeSession: vi.fn().mockResolvedValue(undefined),
    authorizedStreamUrl: vi.fn(),
    getServerUrl: vi.fn(() => 'https://books.test'),
    getAccessToken: vi.fn(() => 'token')
  } as unknown as AbsClient
}

describe('native progress sync', () => {
  let api: AbsClient

  beforeEach(() => {
    vi.useFakeTimers()
    api = fakeApi()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts a periodic sync once playing begins', async () => {
    const sync = createNativeProgressSync(api, 's1')
    sync.observe(snapshot({ status: 'playing', currentTime: 0 }))
    sync.observe(snapshot({ status: 'playing', currentTime: 30 }))
    await vi.advanceTimersByTimeAsync(15_000)
    expect(api.syncSession).toHaveBeenCalledWith('s1', expect.objectContaining({ currentTime: 30, timeListened: 30 }))
  })

  it('pausing syncs the current position immediately and stops the timer', async () => {
    const sync = createNativeProgressSync(api, 's1')
    sync.observe(snapshot({ status: 'playing', currentTime: 0 }))
    sync.observe(snapshot({ status: 'paused', currentTime: 7 }))
    expect(api.syncSession).toHaveBeenCalledWith('s1', expect.objectContaining({ currentTime: 7, timeListened: 7 }))
    ;(api.syncSession as ReturnType<typeof vi.fn>).mockClear()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(api.syncSession).not.toHaveBeenCalled()
  })

  it('ended/error snapshots stop the timer without a sync call', async () => {
    const sync = createNativeProgressSync(api, 's1')
    sync.observe(snapshot({ status: 'playing', currentTime: 0 }))
    sync.observe(snapshot({ status: 'ended', currentTime: 3600 }))
    ;(api.syncSession as ReturnType<typeof vi.fn>).mockClear()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(api.syncSession).not.toHaveBeenCalled()
  })

  it('flush reports the current position now and leaves the session and timer running', async () => {
    const sync = createNativeProgressSync(api, 's1')
    sync.observe(snapshot({ status: 'playing', currentTime: 0 }))
    sync.observe(snapshot({ status: 'playing', currentTime: 9 }))
    await sync.flush()

    expect(api.syncSession).toHaveBeenCalledTimes(1)
    expect(api.syncSession).toHaveBeenCalledWith('s1', expect.objectContaining({ currentTime: 9, timeListened: 9 }))
    expect(api.closeSession).not.toHaveBeenCalled()

    // Not double-counted by the next periodic sync, which keeps firing.
    sync.observe(snapshot({ status: 'playing', currentTime: 20 }))
    await vi.advanceTimersByTimeAsync(15_000)
    expect(api.syncSession).toHaveBeenCalledTimes(2)
    expect(api.syncSession).toHaveBeenLastCalledWith('s1', expect.objectContaining({ currentTime: 20, timeListened: 11 }))
  })

  it('flush does nothing when no time has been listened since the last report', async () => {
    const sync = createNativeProgressSync(api, 's1')
    await sync.flush()
    sync.observe(snapshot({ status: 'playing', currentTime: 5 }))
    await sync.flush()
    ;(api.syncSession as ReturnType<typeof vi.fn>).mockClear()
    await sync.flush()
    expect(api.syncSession).not.toHaveBeenCalled()
  })

  it('flush never rejects when the server rejects', async () => {
    ;(api.syncSession as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('server gone'))
    const sync = createNativeProgressSync(api, 's1')
    sync.observe(snapshot({ status: 'playing', currentTime: 12 }))
    await expect(sync.flush()).resolves.toBeUndefined()
    expect(api.syncSession).toHaveBeenCalledTimes(1)
  })

  it('a failing periodic sync is swallowed instead of becoming an unhandled rejection', async () => {
    ;(api.syncSession as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('server gone'))
    const sync = createNativeProgressSync(api, 's1')
    sync.observe(snapshot({ status: 'playing', currentTime: 0 }))
    sync.observe(snapshot({ status: 'playing', currentTime: 15 }))
    // An unhandled rejection would fail the vitest run; reaching the assertion means it was caught.
    await vi.advanceTimersByTimeAsync(15_000)
    expect(api.syncSession).toHaveBeenCalledTimes(1)
  })

  it('flush after close does not report to the closed session', async () => {
    const sync = createNativeProgressSync(api, 's1')
    sync.observe(snapshot({ status: 'playing', currentTime: 12 }))
    await sync.close()
    await sync.flush()
    expect(api.syncSession).not.toHaveBeenCalled()
  })

  it('close reports final progress and stops the timer', async () => {
    const sync = createNativeProgressSync(api, 's1')
    sync.observe(snapshot({ status: 'playing', currentTime: 0 }))
    sync.observe(snapshot({ status: 'playing', currentTime: 12 }))
    await sync.close()
    expect(api.closeSession).toHaveBeenCalledWith('s1', expect.objectContaining({ currentTime: 12, timeListened: 12 }))
    ;(api.syncSession as ReturnType<typeof vi.fn>).mockClear()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(api.syncSession).not.toHaveBeenCalled()
  })
})
