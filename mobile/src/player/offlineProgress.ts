import type { AbsClient } from '../api/absClient'
import type { NativeProgressSync } from './nativeProgressSync'
import type { PlayerSnapshot, PlayerStatus } from './playerTypes'

/**
 * Local (on-device) listening progress for offline-capable playback.
 *
 * Why this exists: a downloaded book must be playable with the server unreachable, and when it is
 * there is no ABS session -- so there is no `NativeProgressSync` and every second listened used to
 * be lost, with the next open restarting at 0:00. This module keeps a per-item record on the device
 * so (a) the next open resumes where the user left off and (b) progress made offline can be pushed
 * to the server once it is reachable again (`replayUnsyncedOfflineProgress`).
 *
 * The record is written even while the server IS reachable. That is deliberate: it is what makes a
 * later offline resume work after a session that began online.
 */

/** What is remembered about one item. Keyed by `libraryItemId` in the store. */
export interface OfflineProgressRecord {
  /** Last known position, seconds. */
  currentTime: number
  duration: number
  /** Seconds listened that the ABS server has not been told about. Only grows while no server sync
   * is attached (offline); zeroed by `replayUnsyncedOfflineProgress` once the server has it. */
  unsyncedTimeListened: number
  /** Epoch ms of the last write. */
  updatedAt: number
}

/** The storage seam, same shape of idea as `SettingsStorage` (settings/settingsTypes.ts): a
 * `localStorage`-backed default behind an interface so tests can inject an in-memory double.
 * Synchronous on purpose -- `localStorage` is, and `close()` must be able to flush "synchronously-ish"
 * before the app is backgrounded.
 *
 * INVARIANT: no method ever throws. A corrupt or unavailable store degrades to "no saved progress"
 * (reads return null / []; writes are dropped). Playback must never fail because a progress record
 * could not be read or written. */
export interface OfflineProgressStorage {
  read(libraryItemId: string): OfflineProgressRecord | null
  /** Upsert. */
  write(libraryItemId: string, record: OfflineProgressRecord): void
  clear(libraryItemId: string): void
  /** Every record with `unsyncedTimeListened > 0`. */
  listUnsynced(): Array<{ libraryItemId: string; record: OfflineProgressRecord }>
}

const OFFLINE_PROGRESS_STORAGE_KEY = 'shelfdroid.offlineProgress'

/** Minimum gap between throttled local writes while playing. The native player now reports its
 * position twice a second (500 ms ticker) and `observe` fires on every one of those. */
export const OFFLINE_PROGRESS_WRITE_INTERVAL_MS = 5_000

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** Validates one parsed record; anything malformed is treated as absent rather than trusted (a
 * NaN/negative/string position fed to the native load would be worse than starting from 0). */
function toRecord(value: unknown): OfflineProgressRecord | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as Record<string, unknown>
  if (
    !isNonNegativeNumber(candidate.currentTime) ||
    !isNonNegativeNumber(candidate.duration) ||
    !isNonNegativeNumber(candidate.unsyncedTimeListened) ||
    !isNonNegativeNumber(candidate.updatedAt)
  ) {
    return null
  }
  return {
    currentTime: candidate.currentTime,
    duration: candidate.duration,
    unsyncedTimeListened: candidate.unsyncedTimeListened,
    updatedAt: candidate.updatedAt
  }
}

/** Builds a `localStorage`-backed store over `resolveStorage` (a function so a throwing/absent
 * `window.localStorage` getter is caught by the same try/catch as the reads and writes). All records
 * live under ONE key as an `{ [libraryItemId]: record }` object, so listing the unsynced ones needs
 * no key enumeration. Exported for tests; production uses `localOfflineProgressStorage`. */
export function createLocalStorageOfflineProgress(resolveStorage: () => Storage): OfflineProgressStorage {
  /** Parses the whole map. A `Map` (not a plain object) so an item id like `__proto__` cannot hit
   * the prototype setter. Corrupt JSON, a non-object root and bad entries all yield less/empty data. */
  function readAll(): Map<string, OfflineProgressRecord> {
    const records = new Map<string, OfflineProgressRecord>()
    try {
      const raw = resolveStorage().getItem(OFFLINE_PROGRESS_STORAGE_KEY)
      if (!raw) return records
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return records
      for (const [libraryItemId, value] of Object.entries(parsed)) {
        const record = toRecord(value)
        if (record) records.set(libraryItemId, record)
      }
    } catch {
      // Unavailable storage or corrupt JSON: "no saved progress".
    }
    return records
  }

  function writeAll(records: Map<string, OfflineProgressRecord>): void {
    try {
      resolveStorage().setItem(OFFLINE_PROGRESS_STORAGE_KEY, JSON.stringify(Object.fromEntries(records)))
    } catch {
      // Best-effort persistence only (quota exceeded, storage disabled): drop the write.
    }
  }

  return {
    read: (libraryItemId) => readAll().get(libraryItemId) ?? null,
    write(libraryItemId, record) {
      const records = readAll()
      records.set(libraryItemId, record)
      writeAll(records)
    },
    clear(libraryItemId) {
      const records = readAll()
      if (records.delete(libraryItemId)) writeAll(records)
    },
    listUnsynced: () =>
      [...readAll()].filter(([, record]) => record.unsyncedTimeListened > 0).map(([libraryItemId, record]) => ({ libraryItemId, record }))
  }
}

/** Default store: WebView `localStorage`, which survives app restarts in the Capacitor WebView.
 * Never the secure token vault (`auth/vault.ts`) -- a playback position is not a credential, the
 * same call `settings/settingsTypes.ts` makes for its plain preferences. */
export const localOfflineProgressStorage: OfflineProgressStorage = createLocalStorageOfflineProgress(() => window.localStorage)

/** The position to start an offline-played item from: the LATER of what the server says and what
 * this device recorded.
 *
 * Deliberately a max, not "prefer the server". After an hour listened offline the server is stale
 * and the local record is ahead; preferring the server would silently rewind the user and then the
 * next sync would overwrite their real progress with the stale position. `serverCurrentTime` is
 * null when the server was unreachable. */
export function resolveOfflineStartTime(serverCurrentTime: number | null, local: OfflineProgressRecord | null): number {
  const server = isNonNegativeNumber(serverCurrentTime) ? serverCurrentTime : 0
  return Math.max(server, local?.currentTime ?? 0)
}

/** Pushes progress made offline to the server, once, when it is reachable again; best-effort.
 *
 * Only fires when the local record has unsynced listening AND is ahead of the position the new
 * session reports (if the server is already at or past it, there is nothing to correct). On success
 * the counter is zeroed -- re-reading the record first so a position written in the meantime is
 * kept -- so the same time is never reported twice. A failure leaves the record untouched (a later
 * open retries) and never throws: this runs on the offline playback path, whose whole premise is
 * that the server may be flaky. Resolves true only when something was pushed. */
export async function replayUnsyncedOfflineProgress(
  api: Pick<AbsClient, 'syncSession'>,
  sessionId: string,
  libraryItemId: string,
  serverCurrentTime: number,
  storage: OfflineProgressStorage = localOfflineProgressStorage
): Promise<boolean> {
  try {
    const record = storage.read(libraryItemId)
    if (!record || record.unsyncedTimeListened <= 0 || record.currentTime <= serverCurrentTime) return false
    await api.syncSession(sessionId, { currentTime: record.currentTime, timeListened: record.unsyncedTimeListened })
    const latest = storage.read(libraryItemId) ?? record
    storage.write(libraryItemId, { ...latest, unsyncedTimeListened: 0 })
    return true
  } catch {
    return false
  }
}

export interface OfflineProgressSyncOptions {
  storage?: OfflineProgressStorage
  /** Injectable clock (epoch ms) for the throttle and for the listened-time ceiling. */
  now?: () => number
}

/**
 * Wraps (or stands in for) the ABS `NativeProgressSync` so a local record is kept for
 * `libraryItemId` whether or not the server is reachable. `PlayerProvider` installs it as the sync
 * for every offline-capable play, so the ref is never null there.
 *
 * - `observe`: persists position/duration locally (throttled to OFFLINE_PROGRESS_WRITE_INTERVAL_MS
 *   while playing; a status change is written at once so a pause/end is never lost to the throttle),
 *   accumulates `unsyncedTimeListened` ONLY when there is no `wrapped` server sync (with one, the
 *   server is being told), then delegates to `wrapped`.
 * - `close`: flushes the local record first, then closes `wrapped`. NEVER rejects --
 *   `PlayerProvider.teardownNative` relies on that (see its contract comment).
 *
 * Snapshots with no duration yet are not persisted: the native player has not finished preparing,
 * so its position is not the resume position and writing it would clobber the saved one with ~0.
 */
export function createOfflineProgressSync(libraryItemId: string, wrapped: NativeProgressSync | null = null, options: OfflineProgressSyncOptions = {}): NativeProgressSync {
  const storage = options.storage ?? localOfflineProgressStorage
  const now = options.now ?? Date.now

  // Carry forward anything left unsynced by an earlier offline session that has not been replayed.
  let unsyncedTimeListened = storage.read(libraryItemId)?.unsyncedTimeListened ?? 0
  let latest: { currentTime: number; duration: number } | null = null
  let latestStatus: PlayerStatus | null = null
  let lastWrittenAt: number | null = null
  let lastWrittenStatus: PlayerStatus | null = null
  let previous: { currentTime: number; status: PlayerStatus; at: number } | null = null
  let closed = false

  function persist(at: number): void {
    if (!latest) return
    storage.write(libraryItemId, { currentTime: latest.currentTime, duration: latest.duration, unsyncedTimeListened, updatedAt: at })
    lastWrittenAt = at
    lastWrittenStatus = latestStatus
  }

  function accumulate(snapshot: PlayerSnapshot, at: number): void {
    if (wrapped || !previous || previous.status !== 'playing') return
    const advanced = snapshot.currentTime - previous.currentTime
    if (!(advanced > 0)) return
    // Cap by wall-clock time so a seek (which also advances `currentTime`) does not count as
    // listening: genuine playback cannot advance faster than elapsed time x rate. The +1 s absorbs
    // timer jitter between ticks.
    const elapsedSeconds = Math.max(0, (at - previous.at) / 1000)
    const rate = Number.isFinite(snapshot.rate) ? Math.max(snapshot.rate, 1) : 1
    unsyncedTimeListened += Math.min(advanced, elapsedSeconds * rate + 1)
  }

  return {
    observe(snapshot: PlayerSnapshot): void {
      if (!closed) {
        try {
          const at = now()
          accumulate(snapshot, at)
          previous = { currentTime: snapshot.currentTime, status: snapshot.status, at }
          if (snapshot.duration > 0 && Number.isFinite(snapshot.currentTime) && snapshot.currentTime >= 0 && snapshot.status !== 'error') {
            latest = { currentTime: snapshot.currentTime, duration: snapshot.duration }
            latestStatus = snapshot.status
            if (lastWrittenAt === null || snapshot.status !== lastWrittenStatus || at - lastWrittenAt >= OFFLINE_PROGRESS_WRITE_INTERVAL_MS) persist(at)
          }
        } catch {
          // Local bookkeeping must never break the server sync below.
        }
      }
      wrapped?.observe(snapshot)
    },

    async close(): Promise<void> {
      if (!closed) {
        closed = true
        try {
          persist(now())
        } catch {
          // Nothing more to do: the local record is best-effort.
        }
      }
      try {
        await wrapped?.close()
      } catch {
        // The server may be unreachable or have closed the session already; the local record is
        // what matters offline, and `teardownNative` must never see a rejection.
      }
    }
  }
}
