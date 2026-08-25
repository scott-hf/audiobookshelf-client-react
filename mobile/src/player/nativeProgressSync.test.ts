import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AbsClient } from '../api/absClient'
import type { PlayerSnapshot } from './playerTypes'
import { createNativeProgressSync } from './nativeProgressSync'

function snapshot(overrides: Partial<PlayerSnapshot> = {}): PlayerSnapshot {
  return { status: 'playing', itemId: 'b1', currentTime: 0, duration: 3600, error: null, rate: 1, ...overrides }
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
