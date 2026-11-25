import { describe, expect, it, vi } from 'vitest'
import { AbsApiError, type AbsClient, type StartSessionOptions } from '../api/absClient'
import type { NativeProgressSync } from './nativeProgressSync'
import {
  cacheServerProgress,
  createLocalStorageOfflineProgress,
  createOfflineProgressReplayer,
  createOfflineProgressSync,
  OFFLINE_PROGRESS_WRITE_INTERVAL_MS,
  OFFLINE_REPLAY_MIN_INTERVAL_MS,
  OfflineProgressRecord,
  OfflineProgressStorage,
  replayAllUnsyncedOfflineProgress,
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

  it('starts a downloaded-but-never-played book at its cached server position when offline', () => {
    expect(resolveOfflineStartTime(null, record({ currentTime: 843, source: 'server-cache' }))).toBe(843)
  })

  it('prefers the live server position over a cached snapshot, even a lower one', () => {
    expect(resolveOfflineStartTime(900, record({ currentTime: 843, source: 'server-cache' }))).toBe(900)
    expect(resolveOfflineStartTime(10, record({ currentTime: 843, source: 'server-cache' }))).toBe(10)
  })

  it('still resolves an old-format record (no source field) as a listening position', () => {
    const legacy = { currentTime: 500, duration: 3600, unsyncedTimeListened: 12, updatedAt: 1 }
    const storage = fakeStorage({ [KEY]: JSON.stringify({ b1: legacy }) })
    const loaded = createLocalStorageOfflineProgress(() => storage).read('b1')

    expect(loaded).toEqual(legacy)
    expect(loaded?.source).toBeUndefined()
    expect(resolveOfflineStartTime(null, loaded)).toBe(500)
    expect(resolveOfflineStartTime(100, loaded)).toBe(500)
    expect(resolveOfflineStartTime(900, loaded)).toBe(900)
  })
})

describe('cacheServerProgress', () => {
  it('stores a server snapshot that resolves as the offline start time and is not "unsynced"', () => {
    const store = memoryStore()

    expect(cacheServerProgress('b1', 843, { storage: store, duration: 3600, now: () => 5 })).toBe(true)

    expect(store.read('b1')).toEqual({ currentTime: 843, duration: 3600, unsyncedTimeListened: 0, updatedAt: 5, source: 'server-cache' })
    expect(resolveOfflineStartTime(null, store.read('b1'))).toBe(843)
    expect(store.listUnsynced()).toEqual([])
  })

  it('survives a store round-trip through the real storage key (app restart)', () => {
    const storage = fakeStorage()
    cacheServerProgress('b1', 843, { storage: createLocalStorageOfflineProgress(() => storage) })
    expect(createLocalStorageOfflineProgress(() => storage).read('b1')).toMatchObject({ currentTime: 843, source: 'server-cache' })
  })

  it('refreshes an earlier snapshot', () => {
    const store = memoryStore()
    cacheServerProgress('b1', 100, { storage: store })
    expect(cacheServerProgress('b1', 400, { storage: store })).toBe(true)
    expect(store.read('b1')).toMatchObject({ currentTime: 400, source: 'server-cache' })
  })

  it('never overwrites a position actually listened to, even a lower one (offline listening wins)', () => {
    const store = memoryStore()
    store.write('b1', record({ currentTime: 30, unsyncedTimeListened: 45 }))

    expect(cacheServerProgress('b1', 843, { storage: store })).toBe(false)

    expect(store.read('b1')).toEqual(record({ currentTime: 30, unsyncedTimeListened: 45 }))
    expect(resolveOfflineStartTime(null, store.read('b1'))).toBe(30)
  })

  it('is replaced by the first real playback write, which then wins over the old snapshot', async () => {
    const store = memoryStore()
    cacheServerProgress('b1', 843, { storage: store })
    const sync = createOfflineProgressSync('b1', null, { storage: store, now: () => 1_000 })

    sync.observe(snapshot({ currentTime: 20 }))
    await sync.close()

    expect(store.read('b1')?.source).toBeUndefined()
    expect(resolveOfflineStartTime(null, store.read('b1'))).toBe(20)
  })

  it('does not feed the unsynced replay (nothing was listened)', async () => {
    const store = memoryStore()
    cacheServerProgress('b1', 843, { storage: store })
    const syncSession = vi.fn().mockResolvedValue(undefined)

    await expect(replayUnsyncedOfflineProgress({ syncSession } as never, 's', 'b1', 0, store)).resolves.toBe(false)
    expect(syncSession).not.toHaveBeenCalled()
  })

  it('clearing the item removes the snapshot', () => {
    const store = memoryStore()
    cacheServerProgress('b1', 843, { storage: store })
    store.clear('b1')
    expect(store.read('b1')).toBeNull()
    expect(resolveOfflineStartTime(null, store.read('b1'))).toBe(0)
  })

  it('ignores invalid positions and never throws over an unavailable store', () => {
    const store = memoryStore()
    expect(cacheServerProgress('b1', Number.NaN, { storage: store })).toBe(false)
    expect(cacheServerProgress('b1', -1, { storage: store })).toBe(false)
    expect(store.read('b1')).toBeNull()

    const broken = createLocalStorageOfflineProgress(() => {
      throw new Error('no storage')
    })
    expect(() => cacheServerProgress('b1', 5, { storage: broken })).not.toThrow()
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

describe('replayAllUnsyncedOfflineProgress (no open session: every stranded item, on reconnect)', () => {
  const START: StartSessionOptions = {
    deviceInfo: { clientName: 'ShelfDroid', deviceId: 'd' },
    supportedMimeTypes: [],
    mediaPlayer: 'exo',
    forceTranscode: false,
    forceDirectPlay: false
  }

  /** `positions` is what the server reports per item when a session is started for it. */
  function sessionApi(positions: Record<string, number> = {}) {
    const startSession = vi.fn(async (id: string) => ({ id: `sess-${id}`, currentTime: positions[id] ?? 0, audioTracks: [] }))
    const closeSession = vi.fn().mockResolvedValue(undefined)
    return { startSession, closeSession, api: { startSession, closeSession } as unknown as Pick<AbsClient, 'startSession' | 'closeSession'> }
  }

  function stranded(store: OfflineProgressStorage, id: string, currentTime: number, unsyncedTimeListened: number): void {
    store.write(id, record({ currentTime, unsyncedTimeListened }))
  }

  it('pushes every stranded record through its own short-lived session, then zeroes each counter', async () => {
    const store = memoryStore()
    stranded(store, 'b1', 8_191, 25)
    stranded(store, 'b2', 700, 600)
    stranded(store, 'b3', 90, 80)
    store.write('b4', record({ currentTime: 300, unsyncedTimeListened: 0 })) // nothing listened
    const { api, startSession, closeSession } = sessionApi({ b1: 8_166, b2: 0, b3: 10 })

    await expect(replayAllUnsyncedOfflineProgress(api, START, { storage: store })).resolves.toBe(3)

    expect(startSession.mock.calls.map((call) => call[0])).toEqual(['b1', 'b2', 'b3'])
    expect(startSession).toHaveBeenCalledWith('b1', START)
    expect(closeSession).toHaveBeenCalledTimes(3)
    expect(closeSession).toHaveBeenCalledWith('sess-b1', { currentTime: 8_191, timeListened: 25 })
    expect(closeSession).toHaveBeenCalledWith('sess-b2', { currentTime: 700, timeListened: 600 })
    expect(closeSession).toHaveBeenCalledWith('sess-b3', { currentTime: 90, timeListened: 80 })
    expect(store.listUnsynced()).toEqual([])
    // Positions survive (they are what an offline resume reads); only the counters are zeroed.
    expect(store.read('b1')).toEqual(record({ currentTime: 8_191, unsyncedTimeListened: 0 }))
    expect(store.read('b4')).toEqual(record({ currentTime: 300 }))
  })

  it('never pushes a server-cache snapshot, even one that wrongly carries a counter', async () => {
    const store = memoryStore()
    cacheServerProgress('snapshot', 843, { storage: store })
    store.write('corrupt', record({ currentTime: 900, unsyncedTimeListened: 50, source: 'server-cache' }))
    const { api, startSession, closeSession } = sessionApi()

    await expect(replayAllUnsyncedOfflineProgress(api, START, { storage: store })).resolves.toBe(0)

    expect(startSession).not.toHaveBeenCalled()
    expect(closeSession).not.toHaveBeenCalled()
    expect(store.read('snapshot')).toMatchObject({ currentTime: 843, unsyncedTimeListened: 0, source: 'server-cache' })
    expect(store.read('corrupt')?.unsyncedTimeListened).toBe(50)
  })

  it('does not send a position at or behind the server, and stops reprobing it on every run', async () => {
    const store = memoryStore()
    stranded(store, 'equal', 500, 40)
    stranded(store, 'behind', 400, 30)
    stranded(store, 'ahead', 600, 60)
    const { api, closeSession } = sessionApi({ equal: 500, behind: 900, ahead: 100 })

    await expect(replayAllUnsyncedOfflineProgress(api, START, { storage: store })).resolves.toBe(1)

    // The only close that carries listening is the one for the item that is genuinely ahead; the
    // other two sessions were opened to read the server position and closed reporting it unchanged.
    expect(closeSession.mock.calls.filter((call) => (call[1] as { timeListened: number }).timeListened > 0)).toEqual([['sess-ahead', { currentTime: 600, timeListened: 60 }]])
    expect(closeSession).toHaveBeenCalledWith('sess-equal', { currentTime: 500, timeListened: 0 })
    expect(closeSession).toHaveBeenCalledWith('sess-behind', { currentTime: 900, timeListened: 0 })
    expect(store.listUnsynced()).toEqual([])
    // Local positions are untouched: a later offline resume still takes max(server, local).
    expect(store.read('behind')?.currentTime).toBe(400)
  })

  it('leaves the counter intact when the server rejects the push, and delivers it on a later run', async () => {
    const store = memoryStore()
    stranded(store, 'b1', 700, 600)
    const { api, closeSession } = sessionApi()
    closeSession.mockRejectedValueOnce(new Error('connection dropped'))

    await expect(replayAllUnsyncedOfflineProgress(api, START, { storage: store })).resolves.toBe(0)
    expect(store.read('b1')?.unsyncedTimeListened).toBe(600)

    await expect(replayAllUnsyncedOfflineProgress(api, START, { storage: store })).resolves.toBe(1)
    expect(store.read('b1')?.unsyncedTimeListened).toBe(0)
  })

  it('stops at the first sign the server is unreachable instead of timing out once per item', async () => {
    const store = memoryStore()
    stranded(store, 'b1', 700, 60)
    stranded(store, 'b2', 700, 60)
    stranded(store, 'b3', 700, 60)
    const { api, startSession } = sessionApi()
    startSession.mockRejectedValue(new TypeError('Failed to fetch'))

    await expect(replayAllUnsyncedOfflineProgress(api, START, { storage: store })).resolves.toBe(0)

    expect(startSession).toHaveBeenCalledTimes(1)
    expect(store.listUnsynced()).toHaveLength(3)
  })

  it('skips an item the server rejects specifically (deleted, 404) and still delivers the rest', async () => {
    const store = memoryStore()
    stranded(store, 'gone', 700, 60)
    stranded(store, 'b2', 700, 60)
    const { api, startSession } = sessionApi()
    startSession.mockImplementation(async (id: string) => {
      if (id === 'gone') throw new AbsApiError(404, 'Not found')
      return { id: `sess-${id}`, currentTime: 0, audioTracks: [] }
    })

    await expect(replayAllUnsyncedOfflineProgress(api, START, { storage: store })).resolves.toBe(1)

    expect(store.read('gone')?.unsyncedTimeListened).toBe(60)
    expect(store.read('b2')?.unsyncedTimeListened).toBe(0)
  })

  it('treats 401, 408, 429 and 5xx as "the server cannot be used now" and stops, unlike a per-item 404', async () => {
    for (const status of [401, 500, 408, 429]) {
      const store = memoryStore()
      stranded(store, 'b1', 700, 60)
      stranded(store, 'b2', 700, 60)
      const { api, startSession } = sessionApi()
      startSession.mockRejectedValue(new AbsApiError(status, 'nope'))

      await replayAllUnsyncedOfflineProgress(api, START, { storage: store })

      expect(startSession).toHaveBeenCalledTimes(1)
    }
  })

  it('is idempotent: a second run reports nothing, so timeListened is never counted twice', async () => {
    const store = memoryStore()
    stranded(store, 'b1', 700, 600)
    stranded(store, 'b2', 90, 80)
    const { api, closeSession, startSession } = sessionApi()

    await expect(replayAllUnsyncedOfflineProgress(api, START, { storage: store })).resolves.toBe(2)
    await expect(replayAllUnsyncedOfflineProgress(api, START, { storage: store })).resolves.toBe(0)

    expect(startSession).toHaveBeenCalledTimes(2)
    expect(closeSession).toHaveBeenCalledTimes(2)
  })

  it('leaves the active item to the live player', async () => {
    const store = memoryStore()
    stranded(store, 'playing', 700, 60)
    stranded(store, 'idle', 700, 60)
    const { api, startSession, closeSession } = sessionApi()

    await replayAllUnsyncedOfflineProgress(api, START, { storage: store, isItemActive: (id) => id === 'playing' })

    expect(startSession.mock.calls.map((call) => call[0])).toEqual(['idle'])
    expect(closeSession).toHaveBeenCalledTimes(1)
    expect(store.read('playing')?.unsyncedTimeListened).toBe(60)
  })

  it('backs off when the item became active while its session request was in flight', async () => {
    const store = memoryStore()
    stranded(store, 'b1', 700, 60)
    const { closeSession } = sessionApi()
    let active = false
    const startSession = vi.fn(async (id: string) => {
      active = true // the user pressed play on it during the request
      return { id: `sess-${id}`, currentTime: 0, audioTracks: [] }
    })

    await expect(
      replayAllUnsyncedOfflineProgress({ startSession, closeSession } as unknown as Pick<AbsClient, 'startSession' | 'closeSession'>, START, {
        storage: store,
        isItemActive: () => active
      })
    ).resolves.toBe(0)

    expect(closeSession).toHaveBeenCalledTimes(1)
    expect(closeSession).toHaveBeenCalledWith('sess-b1', { currentTime: 0, timeListened: 0 }) // the probe, reporting nothing
    expect(store.read('b1')?.unsyncedTimeListened).toBe(60)
  })

  it('never lets the per-item replay and the all-items replay push the same item at once', async () => {
    const store = memoryStore()
    stranded(store, 'b1', 700, 60)
    const { closeSession } = sessionApi()
    let releaseSession: (() => void) | undefined
    const startSession = vi.fn(
      (id: string) =>
        new Promise<{ id: string; currentTime: number; audioTracks: never[] }>((resolve) => {
          releaseSession = () => resolve({ id: `sess-${id}`, currentTime: 0, audioTracks: [] })
        })
    )
    const syncSession = vi.fn().mockResolvedValue(undefined)

    const all = replayAllUnsyncedOfflineProgress({ startSession, closeSession } as unknown as Pick<AbsClient, 'startSession' | 'closeSession'>, START, { storage: store })
    // Play of the same item opens its own session and tries to replay while the other is mid-flight.
    await expect(replayUnsyncedOfflineProgress({ syncSession } as never, 'play-session', 'b1', 0, store)).resolves.toBe(false)
    releaseSession?.()
    await expect(all).resolves.toBe(1)

    expect(syncSession).not.toHaveBeenCalled()
    expect(closeSession).toHaveBeenCalledTimes(1)
    expect(store.read('b1')?.unsyncedTimeListened).toBe(0)
  })

  it('never throws, even over an unavailable store', async () => {
    const broken = createLocalStorageOfflineProgress(() => {
      throw new Error('no storage')
    })
    const { api } = sessionApi()
    await expect(replayAllUnsyncedOfflineProgress(api, START, { storage: broken })).resolves.toBe(0)
  })
})

describe('createOfflineProgressReplayer', () => {
  const START: StartSessionOptions = {
    deviceInfo: { clientName: 'ShelfDroid', deviceId: 'd' },
    supportedMimeTypes: [],
    mediaPlayer: 'exo',
    forceTranscode: false,
    forceDirectPlay: false
  }

  function setup() {
    const store = memoryStore()
    store.write('b1', record({ currentTime: 700, unsyncedTimeListened: 60 }))
    const startSession = vi.fn(async (id: string) => ({ id: `sess-${id}`, currentTime: 0, audioTracks: [] }))
    const closeSession = vi.fn().mockResolvedValue(undefined)
    let clock = 1_000_000
    const replayer = createOfflineProgressReplayer({ startSession, closeSession } as unknown as Pick<AbsClient, 'startSession' | 'closeSession'>, START, {
      storage: store,
      now: () => clock
    })
    return { store, startSession, closeSession, replayer, advance: (ms: number) => void (clock += ms) }
  }

  it('is single-flight: overlapping triggers share one run', async () => {
    const { replayer, startSession } = setup()
    const first = replayer.run()
    const second = replayer.run({ force: true })
    await expect(Promise.all([first, second])).resolves.toEqual([1, 1])
    expect(startSession).toHaveBeenCalledTimes(1)
  })

  it('throttles foreground-style runs but always lets a network-return run through', async () => {
    const { replayer, store, startSession, advance } = setup()
    startSession.mockRejectedValueOnce(new TypeError('Failed to fetch')) // first attempt: still offline
    await expect(replayer.run()).resolves.toBe(0)
    expect(store.listUnsynced()).toHaveLength(1)

    // Another foreground a moment later is throttled: no request at all, and no timer retrying.
    advance(OFFLINE_REPLAY_MIN_INTERVAL_MS - 1)
    await expect(replayer.run()).resolves.toBe(0)
    expect(startSession).toHaveBeenCalledTimes(1)

    // The network coming back is not throttled, so the earlier failure cannot swallow it.
    await expect(replayer.run({ force: true })).resolves.toBe(1)
    expect(startSession).toHaveBeenCalledTimes(2)
  })

  it('runs again once the minimum interval has passed', async () => {
    const { replayer, store, startSession, advance } = setup()
    startSession.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await replayer.run()
    advance(OFFLINE_REPLAY_MIN_INTERVAL_MS)
    await expect(replayer.run()).resolves.toBe(1)
    expect(store.listUnsynced()).toEqual([])
  })

  it('makes no request when nothing is stranded, and does not burn the throttle doing so', async () => {
    const { replayer, store, startSession } = setup()
    store.write('b1', record({ currentTime: 700, unsyncedTimeListened: 0 }))
    await expect(replayer.run()).resolves.toBe(0)
    expect(startSession).not.toHaveBeenCalled()

    store.write('b1', record({ currentTime: 700, unsyncedTimeListened: 60 }))
    await expect(replayer.run()).resolves.toBe(1)
  })
})

describe('createOfflineProgressSync: the store owns the unsynced counter', () => {
  it('respects a replay that delivered and zeroed the counter while the item was loaded', async () => {
    const backing = memoryStore()
    backing.write('b1', record({ currentTime: 50, unsyncedTimeListened: 90 }))
    let clock = 1_000_000
    const sync = createOfflineProgressSync('b1', null, { storage: backing, now: () => clock })

    sync.observe(snapshot({ currentTime: 100 }))
    clock += 1_000
    sync.observe(snapshot({ currentTime: 101 }))
    // The all-items replay pushes the 90 s already stored and zeroes it.
    backing.write('b1', { ...(backing.read('b1') as OfflineProgressRecord), unsyncedTimeListened: 0 })
    await sync.close()

    // Only the second listened since; the delivered 90 are not written back.
    expect(backing.read('b1')?.unsyncedTimeListened).toBeCloseTo(1, 5)
  })

  it('does not lose accrued time when a write is silently dropped; the next persist retries it', async () => {
    const backing = memoryStore()
    let drop = true
    const storage: OfflineProgressStorage = { ...backing, write: (id, rec) => (drop ? undefined : backing.write(id, rec)) }
    let clock = 1_000_000
    const sync = createOfflineProgressSync('b1', null, { storage, now: () => clock })

    sync.observe(snapshot({ currentTime: 10 }))
    clock += 1_000
    sync.observe(snapshot({ currentTime: 11 }))
    await sync.flush() // dropped
    expect(backing.read('b1')).toBeNull()

    drop = false
    clock += 1_000
    sync.observe(snapshot({ currentTime: 12 }))
    await sync.close()
    expect(backing.read('b1')?.unsyncedTimeListened).toBeCloseTo(2, 5)
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
      flush: vi.fn().mockResolvedValue(undefined),
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
      flush: vi.fn().mockResolvedValue(undefined),
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
    const wrapped: NativeProgressSync = { observe: vi.fn(), flush: vi.fn(), close: vi.fn().mockRejectedValue(new Error('server gone')) }
    const { sync, storage } = setup(wrapped)
    sync.observe(snapshot({ currentTime: 42 }))

    await expect(sync.close()).resolves.toBeUndefined()
    expect(storage.read('b1')?.currentTime).toBe(42)
    await expect(sync.close()).resolves.toBeUndefined()
  })

  it('flush() writes the latest position now, bypassing the throttle, without closing anything', async () => {
    const wrapped: NativeProgressSync = { observe: vi.fn(), flush: vi.fn().mockResolvedValue(undefined), close: vi.fn() }
    const { sync, storage, write, advance } = setup(wrapped)
    sync.observe(snapshot({ currentTime: 10 })) // first snapshot: written
    advance(1_000) // well inside the 5 s throttle window
    sync.observe(snapshot({ currentTime: 11 })) // throttled: not written
    expect(write).toHaveBeenCalledTimes(1)
    expect(storage.read('b1')?.currentTime).toBe(10)

    await sync.flush()

    expect(write).toHaveBeenCalledTimes(2)
    expect(storage.read('b1')?.currentTime).toBe(11)
    expect(wrapped.flush).toHaveBeenCalledTimes(1)
    expect(wrapped.close).not.toHaveBeenCalled()

    // Still open afterwards: playback continues and observe keeps recording and delegating.
    advance(1_000)
    sync.observe(snapshot({ currentTime: 12 }))
    expect(wrapped.observe).toHaveBeenCalledTimes(3)
    await sync.close()
    expect(storage.read('b1')?.currentTime).toBe(12)
  })

  it('flush() never rejects when the wrapped sync rejects, and still writes locally', async () => {
    const wrapped: NativeProgressSync = { observe: vi.fn(), flush: vi.fn().mockRejectedValue(new Error('server gone')), close: vi.fn() }
    const { sync, storage } = setup(wrapped)
    sync.observe(snapshot({ currentTime: 42 }))

    await expect(sync.flush()).resolves.toBeUndefined()
    expect(wrapped.flush).toHaveBeenCalledTimes(1)
    expect(storage.read('b1')?.currentTime).toBe(42)
  })

  it('flush() over an unavailable store, with no wrapped sync and no snapshot yet, resolves quietly', async () => {
    const broken = createLocalStorageOfflineProgress(() => {
      throw new Error('no storage')
    })
    const sync = createOfflineProgressSync('b1', null, { storage: broken })
    await expect(sync.flush()).resolves.toBeUndefined()
    sync.observe(snapshot({ currentTime: 3 }))
    await expect(sync.flush()).resolves.toBeUndefined()
  })

  it('flush() after close() writes nothing locally', async () => {
    const { sync, write } = setup()
    sync.observe(snapshot({ currentTime: 5 }))
    await sync.close()
    write.mockClear()
    await sync.flush()
    expect(write).not.toHaveBeenCalled()
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
    const wrapped: NativeProgressSync = { observe: vi.fn(), flush: vi.fn(), close: vi.fn().mockResolvedValue(undefined) }
    const sync = createOfflineProgressSync('b1', wrapped, { storage: broken })

    expect(() => sync.observe(snapshot({ currentTime: 3 }))).not.toThrow()
    await expect(sync.close()).resolves.toBeUndefined()
    expect(wrapped.observe).toHaveBeenCalledTimes(1)
    expect(wrapped.close).toHaveBeenCalledTimes(1)
  })
})
