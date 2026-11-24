import { describe, expect, it, vi } from 'vitest'
import type { AbsClient } from '../api/absClient'
import type { NativeProgressSync } from './nativeProgressSync'
import {
  createLocalStorageOfflineProgress,
  createOfflineProgressSync,
  OFFLINE_PROGRESS_WRITE_INTERVAL_MS,
  OfflineProgressRecord,
  OfflineProgressStorage,
  replayUnsyncedOfflineProgress,
  resolveOfflineStartTime
} from './offlineProgress'
import type { PlayerSnapshot } from './playerTypes'

const KEY = 'shelfdroid.offlineProgress'

/** Minimal in-memory `Storage` so the real JSON/try-catch code path runs without jsdom state. */
function fakeStorage(initial: Record<string, string> = {}): Storage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial))
  return {
    data,
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => void data.delete(key),
    setItem: (key: string, value: string) => void data.set(key, value)
  }
}

/** A store over ONE persistent fake `Storage` (the resolver is called on every operation). */
function memoryStore(): OfflineProgressStorage {
  const storage = fakeStorage()
  return createLocalStorageOfflineProgress(() => storage)
}

function record(overrides: Partial<OfflineProgressRecord> = {}): OfflineProgressRecord {
  return { currentTime: 120, duration: 3600, unsyncedTimeListened: 0, updatedAt: 1_000, ...overrides }
}

function snapshot(overrides: Partial<PlayerSnapshot> = {}): PlayerSnapshot {
  return { status: 'playing', itemId: 'b1', currentTime: 0, duration: 3600, error: null, rate: 1, playWhenReady: true, ...overrides }
}

describe('offline progress store', () => {
  it('round-trips, upserts, clears and lists only items with unsynced listening', () => {
    const store = memoryStore()

    expect(store.read('b1')).toBeNull()
    store.write('b1', record({ currentTime: 10 }))
    store.write('b2', record({ currentTime: 20, unsyncedTimeListened: 30 }))
    store.write('b1', record({ currentTime: 15 }))

    expect(store.read('b1')).toEqual(record({ currentTime: 15 }))
    expect(store.read('b2')).toEqual(record({ currentTime: 20, unsyncedTimeListened: 30 }))
    expect(store.listUnsynced()).toEqual([{ libraryItemId: 'b2', record: record({ currentTime: 20, unsyncedTimeListened: 30 }) }])

    store.clear('b2')
    expect(store.read('b2')).toBeNull()
    expect(store.listUnsynced()).toEqual([])
    expect(store.read('b1')).not.toBeNull()
  })

  it('persists through the real storage key so a new store instance (app restart) sees it', () => {
    const storage = fakeStorage()
    createLocalStorageOfflineProgress(() => storage).write('b1', record())
    expect(storage.data.has(KEY)).toBe(true)
    expect(createLocalStorageOfflineProgress(() => storage).read('b1')).toEqual(record())
  })

  it('treats corrupt JSON as no saved progress and recovers on the next write', () => {
    const storage = fakeStorage({ [KEY]: '{not json' })
    const store = createLocalStorageOfflineProgress(() => storage)

    expect(store.read('b1')).toBeNull()
    expect(store.listUnsynced()).toEqual([])
    expect(() => store.clear('b1')).not.toThrow()

    store.write('b1', record())
    expect(store.read('b1')).toEqual(record())
  })

  it('drops malformed entries and non-object roots without throwing', () => {
    const bad = { currentTime: -5, duration: 10, unsyncedTimeListened: 0, updatedAt: 1 }
    const str = { currentTime: '12', duration: 10, unsyncedTimeListened: 0, updatedAt: 1 }
    const storage = fakeStorage({ [KEY]: JSON.stringify({ bad, str, nul: null, ok: record() }) })
    const store = createLocalStorageOfflineProgress(() => storage)

    expect(store.read('bad')).toBeNull()
    expect(store.read('str')).toBeNull()
    expect(store.read('nul')).toBeNull()
    expect(store.read('ok')).toEqual(record())

    for (const root of ['[]', '"text"', '42', 'null']) {
      const rootedStorage = fakeStorage({ [KEY]: root })
      const rooted = createLocalStorageOfflineProgress(() => rootedStorage)
      expect(rooted.read('ok')).toBeNull()
      expect(rooted.listUnsynced()).toEqual([])
    }
  })

  it('never throws when storage is unavailable or full', () => {
    const unavailable = createLocalStorageOfflineProgress(() => {
      throw new Error('SecurityError')
    })
    expect(unavailable.read('b1')).toBeNull()
    expect(unavailable.listUnsynced()).toEqual([])
    expect(() => unavailable.write('b1', record())).not.toThrow()
    expect(() => unavailable.clear('b1')).not.toThrow()

    const full = fakeStorage()
    full.setItem = () => {
      throw new Error('QuotaExceededError')
    }
    const quota = createLocalStorageOfflineProgress(() => full)
    expect(() => quota.write('b1', record())).not.toThrow()
    expect(quota.read('b1')).toBeNull()
  })

  it('handles a prototype-polluting item id as a plain key', () => {
    const store = memoryStore()
    store.write('__proto__', record({ currentTime: 7 }))
    expect(store.read('__proto__')?.currentTime).toBe(7)
    expect(store.read('other')).toBeNull()
  })
})

describe('resolveOfflineStartTime', () => {
  it('takes the local position when it is ahead of a stale server (listened offline)', () => {
    expect(resolveOfflineStartTime(100, record({ currentTime: 3_700 }))).toBe(3_700)
  })

  it('takes the server position when it is ahead (listened on another device)', () => {
    expect(resolveOfflineStartTime(900, record({ currentTime: 500 }))).toBe(900)
  })

  it('uses whichever side exists, and 0 when neither does', () => {
    expect(resolveOfflineStartTime(null, record({ currentTime: 500 }))).toBe(500)
    expect(resolveOfflineStartTime(250, null)).toBe(250)
    expect(resolveOfflineStartTime(null, null)).toBe(0)
    expect(resolveOfflineStartTime(Number.NaN, null)).toBe(0)
  })
})

describe('replayUnsyncedOfflineProgress', () => {
  function api(syncSession = vi.fn().mockResolvedValue(undefined)): Pick<AbsClient, 'syncSession'> & { syncSession: ReturnType<typeof vi.fn> } {
    return { syncSession } as never
  }

  function storeWith(rec: OfflineProgressRecord | null): OfflineProgressStorage {
    const store = memoryStore()
    if (rec) store.write('b1', rec)
    return store
  }

  it('pushes the ahead-of-server position once and zeroes the counter', async () => {
    const store = storeWith(record({ currentTime: 3_700, unsyncedTimeListened: 3_600 }))
    const client = api()

    await expect(replayUnsyncedOfflineProgress(client, 'sess-1', 'b1', 100, store)).resolves.toBe(true)

    expect(client.syncSession).toHaveBeenCalledTimes(1)
    expect(client.syncSession).toHaveBeenCalledWith('sess-1', { currentTime: 3_700, timeListened: 3_600 })
    expect(store.read('b1')).toEqual(record({ currentTime: 3_700, unsyncedTimeListened: 0 }))
    expect(store.listUnsynced()).toEqual([])

    // A second open finds nothing left to report.
    await expect(replayUnsyncedOfflineProgress(client, 'sess-2', 'b1', 100, store)).resolves.toBe(false)
    expect(client.syncSession).toHaveBeenCalledTimes(1)
  })

  it('does nothing when there is no record, nothing unsynced, or the server is not behind', async () => {
    const client = api()
    await expect(replayUnsyncedOfflineProgress(client, 's', 'b1', 0, storeWith(null))).resolves.toBe(false)
    await expect(replayUnsyncedOfflineProgress(client, 's', 'b1', 0, storeWith(record({ currentTime: 500, unsyncedTimeListened: 0 })))).resolves.toBe(false)
    const ahead = storeWith(record({ currentTime: 500, unsyncedTimeListened: 40 }))
    await expect(replayUnsyncedOfflineProgress(client, 's', 'b1', 500, ahead)).resolves.toBe(false)
    await expect(replayUnsyncedOfflineProgress(client, 's', 'b1', 900, ahead)).resolves.toBe(false)
    expect(client.syncSession).not.toHaveBeenCalled()
    expect(ahead.read('b1')?.unsyncedTimeListened).toBe(40)
  })

  it('swallows a failed sync, leaves the counter for a later retry, and never throws', async () => {
    const store = storeWith(record({ currentTime: 3_700, unsyncedTimeListened: 60 }))
    const client = api(vi.fn().mockRejectedValue(new Error('network down')))

    await expect(replayUnsyncedOfflineProgress(client, 's', 'b1', 0, store)).resolves.toBe(false)
    expect(store.read('b1')?.unsyncedTimeListened).toBe(60)
  })
})

describe('createOfflineProgressSync', () => {
  function setup(wrapped: NativeProgressSync | null = null, initial?: OfflineProgressRecord) {
    const backing = memoryStore()
    if (initial) backing.write('b1', initial)
    const write = vi.fn(backing.write)
    const storage: OfflineProgressStorage = { ...backing, write }
    let clock = 1_000_000
    const sync = createOfflineProgressSync('b1', wrapped, { storage, now: () => clock })
    return {
      sync,
      storage,
      write,
      advance: (ms: number) => {
        clock += ms
      }
    }
  }

  it('throttles writes while playing to one per interval despite 500 ms ticks', () => {
    const { sync, write, advance, storage } = setup()

    // 12 s of 500 ms ticks = 25 observations (t = 0 .. 12 000 ms).
    for (let tick = 0; tick <= 24; tick++) {
      sync.observe(snapshot({ currentTime: tick * 0.5 }))
      advance(500)
    }

    // First tick, then one per 5 s boundary (5 000 and 10 000 ms).
    expect(OFFLINE_PROGRESS_WRITE_INTERVAL_MS).toBe(5_000)
    expect(write).toHaveBeenCalledTimes(3)
    expect(storage.read('b1')?.currentTime).toBe(10)
  })

  it('writes a status change immediately so a pause is never lost to the throttle', () => {
    const { sync, write, advance, storage } = setup()
    sync.observe(snapshot({ status: 'playing', currentTime: 1 }))
    advance(500)
    sync.observe(snapshot({ status: 'playing', currentTime: 1.5 }))
    expect(write).toHaveBeenCalledTimes(1)

    advance(500)
    sync.observe(snapshot({ status: 'paused', currentTime: 2, playWhenReady: false }))
    expect(write).toHaveBeenCalledTimes(2)
    expect(storage.read('b1')?.currentTime).toBe(2)
  })

  it('does not persist a position before the player has a duration, or an error snapshot', () => {
    const { sync, write } = setup(null, record({ currentTime: 500 }))
    sync.observe(snapshot({ status: 'buffering', currentTime: 0, duration: 0 }))
    sync.observe(snapshot({ status: 'error', currentTime: 0, duration: 3600 }))
    expect(write).not.toHaveBeenCalled()
  })

  it('accumulates unsynced listening offline and flushes it on close', async () => {
    const { sync, storage, advance } = setup()
    for (let second = 0; second <= 4; second++) {
      sync.observe(snapshot({ currentTime: 100 + second }))
      advance(1_000)
    }
    await sync.close()

    expect(storage.read('b1')).toMatchObject({ currentTime: 104, duration: 3600 })
    expect(storage.read('b1')?.unsyncedTimeListened).toBeCloseTo(4, 5)
    expect(storage.listUnsynced()).toHaveLength(1)
  })

  it('does not count a seek, a pause interval, or a rewind as listening', async () => {
    const { sync, storage, advance } = setup()
    sync.observe(snapshot({ currentTime: 100 }))
    advance(1_000)
    sync.observe(snapshot({ currentTime: 1_000 })) // forward seek: capped by elapsed wall time
    advance(1_000)
    sync.observe(snapshot({ status: 'paused', currentTime: 1_001, playWhenReady: false }))
    advance(60_000)
    sync.observe(snapshot({ status: 'paused', currentTime: 1_001, playWhenReady: false })) // paused: nothing
    advance(500)
    sync.observe(snapshot({ status: 'playing', currentTime: 50 })) // rewind: nothing
    await sync.close()

    const unsynced = storage.read('b1')?.unsyncedTimeListened ?? 0
    expect(unsynced).toBeGreaterThan(0)
    expect(unsynced).toBeLessThanOrEqual(3)
  })

  it('carries forward unsynced listening left by an earlier offline session', async () => {
    const { sync, storage } = setup(null, record({ currentTime: 50, unsyncedTimeListened: 90 }))
    sync.observe(snapshot({ currentTime: 60 }))
    await sync.close()
    expect(storage.read('b1')?.unsyncedTimeListened).toBe(90)
    expect(storage.read('b1')?.currentTime).toBe(60)
  })

  it('records position but not unsynced time, and delegates to the wrapped sync when a server session exists', async () => {
    const calls: string[] = []
    const wrapped: NativeProgressSync = {
      observe: vi.fn(() => void calls.push('observe')),
      close: vi.fn(async () => void calls.push('close'))
    }
    const { sync, storage, advance } = setup(wrapped)

    sync.observe(snapshot({ currentTime: 10 }))
    advance(1_000)
    sync.observe(snapshot({ currentTime: 11 }))
    await sync.close()

    expect(wrapped.observe).toHaveBeenCalledTimes(2)
    expect(wrapped.close).toHaveBeenCalledTimes(1)
    expect(storage.read('b1')).toMatchObject({ currentTime: 11, unsyncedTimeListened: 0 })
    expect(calls).toEqual(['observe', 'observe', 'close'])
  })

  it('flushes the local record before closing the wrapped sync', async () => {
    let recordWhenWrappedClosed: OfflineProgressRecord | null = null
    let storageRef: OfflineProgressStorage | null = null
    const wrapped: NativeProgressSync = {
      observe: vi.fn(),
      close: vi.fn(async () => {
        recordWhenWrappedClosed = storageRef?.read('b1') ?? null
      })
    }
    const { sync, storage, advance } = setup(wrapped)
    storageRef = storage
    sync.observe(snapshot({ currentTime: 10 }))
    advance(1_000) // inside the throttle window: only close() can have persisted position 12
    sync.observe(snapshot({ currentTime: 12 }))
    await sync.close()

    expect(recordWhenWrappedClosed).toMatchObject({ currentTime: 12 })
  })

  it('close() never rejects when the wrapped sync rejects, and still flushes locally', async () => {
    const wrapped: NativeProgressSync = { observe: vi.fn(), close: vi.fn().mockRejectedValue(new Error('server gone')) }
    const { sync, storage } = setup(wrapped)
    sync.observe(snapshot({ currentTime: 42 }))

    await expect(sync.close()).resolves.toBeUndefined()
    expect(storage.read('b1')?.currentTime).toBe(42)
    await expect(sync.close()).resolves.toBeUndefined()
  })

  it('does nothing local after close and does not write on close without any snapshot', async () => {
    const { sync, write } = setup()
    await sync.close()
    sync.observe(snapshot({ currentTime: 5 }))
    expect(write).not.toHaveBeenCalled()
  })

  it('keeps working (and never throws) over an unavailable store', async () => {
    const broken = createLocalStorageOfflineProgress(() => {
      throw new Error('no storage')
    })
    const wrapped: NativeProgressSync = { observe: vi.fn(), close: vi.fn().mockResolvedValue(undefined) }
    const sync = createOfflineProgressSync('b1', wrapped, { storage: broken })

    expect(() => sync.observe(snapshot({ currentTime: 3 }))).not.toThrow()
    await expect(sync.close()).resolves.toBeUndefined()
    expect(wrapped.observe).toHaveBeenCalledTimes(1)
    expect(wrapped.close).toHaveBeenCalledTimes(1)
  })
})
