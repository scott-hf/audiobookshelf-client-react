import { AbsApiError, type AbsClient, type StartSessionOptions } from '../api/absClient'
import type { NativeProgressSync } from './nativeProgressSync'
import type { PlayerSnapshot, PlayerStatus } from './playerTypes'

/**
 * Local (on-device) listening progress for offline-capable playback.
 *
 * Why this exists: a downloaded book must be playable with the server unreachable, and when it is
 * there is no ABS session -- so there is no `NativeProgressSync` and every second listened used to
 * be lost, with the next open restarting at 0:00. This module keeps a per-item record on the device
 * so (a) the next open resumes where the user left off and (b) progress made offline can be pushed
 * to the server once it is reachable again: for EVERY stranded item when the app starts, returns to
 * the foreground or the network comes back (`createOfflineProgressReplayer`), and for the item being
 * opened as it starts (`replayUnsyncedOfflineProgress`).
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
  /**
   * Where `currentTime` came from. Absent (every record written before this field existed, and every
   * record the player writes) means "a position this device actually reached while playing": the
   * listener's own, newest-by-definition position. `'server-cache'` means a snapshot of the ABS
   * server's position taken while online (`cacheServerProgress`) for a book that has not been played
   * from this device since -- it only exists so an offline first play does not start at 0:00, and it
   * must lose to anything the server says live and never be treated as listening
   * (`resolveOfflineStartTime`). The first real playback write replaces it with an unmarked record.
   */
  source?: 'server-cache'
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
  const parsed: OfflineProgressRecord = {
    currentTime: candidate.currentTime,
    duration: candidate.duration,
    unsyncedTimeListened: candidate.unsyncedTimeListened,
    updatedAt: candidate.updatedAt
  }
  // Records saved by earlier builds have no `source`; they are real listening positions and stay so.
  if (candidate.source === 'server-cache') parsed.source = 'server-cache'
  return parsed
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

/** The position to start an offline-played item from.
 *
 * Against a real listening record (no `source`): the LATER of what the server says and what this
 * device recorded. Deliberately a max, not "prefer the server". After an hour listened offline the
 * server is stale and the local record is ahead; preferring the server would silently rewind the
 * user and then the next sync would overwrite their real progress with the stale position.
 * `serverCurrentTime` is null when the server was unreachable.
 *
 * Against a cached server snapshot (`source: 'server-cache'`): the live server position when there
 * is one (it is newer than the snapshot, and may legitimately be lower, e.g. a reset), else the
 * snapshot. Never a max with the live value -- a snapshot is not a position the listener reached. */
export function resolveOfflineStartTime(serverCurrentTime: number | null, local: OfflineProgressRecord | null): number {
  const server = isNonNegativeNumber(serverCurrentTime) ? serverCurrentTime : null
  if (local?.source === 'server-cache') return server ?? local.currentTime
  return Math.max(server ?? 0, local?.currentTime ?? 0)
}

export interface CacheServerProgressOptions {
  storage?: OfflineProgressStorage
  /** Total length in seconds, when known (the record is only used for its position). */
  duration?: number
  now?: () => number
}

/** Remembers the ABS server's position for a downloaded item so a first play with the server
 * unreachable resumes there instead of at 0:00. Call it while online (at queue and completion time).
 *
 * Never overwrites a real listening record: once this device has played the item, its own position
 * is newer than any server snapshot, and a stale snapshot must not rewind the listener or wipe the
 * unsynced-listening counter. An earlier snapshot IS refreshed. Best-effort; never throws. Returns
 * true when a snapshot was written. */
export function cacheServerProgress(libraryItemId: string, serverCurrentTime: number, options: CacheServerProgressOptions = {}): boolean {
  try {
    if (!isNonNegativeNumber(serverCurrentTime)) return false
    const storage = options.storage ?? localOfflineProgressStorage
    const existing = storage.read(libraryItemId)
    if (existing && existing.source !== 'server-cache') return false
    const duration = isNonNegativeNumber(options.duration) ? options.duration : (existing?.duration ?? 0)
    storage.write(libraryItemId, {
      currentTime: serverCurrentTime,
      duration,
      unsyncedTimeListened: 0,
      updatedAt: (options.now ?? Date.now)(),
      source: 'server-cache'
    })
    return true
  } catch {
    return false
  }
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
  let claimed = false
  try {
    const record = storage.read(libraryItemId)
    if (!isStranded(record) || record.currentTime <= serverCurrentTime) return false
    // Another push (the all-items replayer) already owns this item: it will deliver the same
    // listening, so doing it here too would count it twice.
    if (itemsBeingReplayed.has(libraryItemId)) return false
    itemsBeingReplayed.add(libraryItemId)
    claimed = true
    await api.syncSession(sessionId, { currentTime: record.currentTime, timeListened: record.unsyncedTimeListened })
    const latest = storage.read(libraryItemId) ?? record
    storage.write(libraryItemId, { ...latest, unsyncedTimeListened: 0 })
    return true
  } catch {
    return false
  } finally {
    if (claimed) itemsBeingReplayed.delete(libraryItemId)
  }
}

/** Items with a push in flight, shared by the per-item replay and the all-items replayer so two
 * writers never push the same item's listening concurrently. */
const itemsBeingReplayed = new Set<string>()

/** True for a record that holds real, unreported listening. A `server-cache` snapshot is the
 * server's own position, never listening, so it is excluded even if a corrupt record also carries a
 * counter. */
function isStranded(record: OfflineProgressRecord | null): record is OfflineProgressRecord {
  return record !== null && record.source !== 'server-cache' && record.unsyncedTimeListened > 0
}

/** Minimum gap between the throttled (startup / foreground) replay runs. A network-return run
 * bypasses it. There is deliberately no internal retry timer: a failed run waits for the next
 * trigger, so a dead server is never polled in a loop. */
export const OFFLINE_REPLAY_MIN_INTERVAL_MS = 30_000

type StrandedOutcome = 'pushed' | 'settled' | 'skipped'

/** A failure specific to one item (it was deleted from the server, access revoked) as opposed to the
 * server being unreachable or the credentials being bad; the former must not block the other items. */
function isPerItemFailure(error: unknown): boolean {
  return error instanceof AbsApiError && error.status >= 400 && error.status < 500 && error.status !== 401 && error.status !== 408 && error.status !== 429
}

/** Best-effort close of a session this module opened only to ask for the server's position. Reports
 * the server's own position and no listening, so it changes nothing. Never throws. */
async function closeProbeSession(api: Pick<AbsClient, 'closeSession'>, session: { id: string; currentTime: number }): Promise<void> {
  try {
    await api.closeSession(session.id, { currentTime: session.currentTime, timeListened: 0 })
  } catch {
    // An open session expires on the server; nothing else to do.
  }
}

/** Reduces the stored counter by `reported` (the amount the server has now accepted or that no
 * longer needs reporting), re-reading the record so a position written meanwhile is kept. A record
 * removed meanwhile is not resurrected. */
function subtractReported(storage: OfflineProgressStorage, libraryItemId: string, reported: number): void {
  const latest = storage.read(libraryItemId)
  if (latest) storage.write(libraryItemId, { ...latest, unsyncedTimeListened: Math.max(0, latest.unsyncedTimeListened - reported) })
}

/** Pushes one stranded item with NO pre-existing playback session.
 *
 * What the ABS client offers is session-scoped only (`startSession`, `syncSession`, `closeSession`;
 * there is no per-item progress route in `AbsClient`), so this opens a short-lived session, which
 * also tells us the server's current position (`session.currentTime`) -- needed to decide whether
 * pushing would help or would rewind -- and then reports through `closeSession`. ABS applies the
 * close payload as a final sync before closing, so the push and the clean-up are ONE request and no
 * session is left open.
 *
 * Throws on any request failure (the caller classifies it); the stored counter is only touched after
 * the server has accepted the close. */
async function pushStrandedItem(
  api: Pick<AbsClient, 'startSession' | 'closeSession'>,
  startOptions: StartSessionOptions,
  storage: OfflineProgressStorage,
  isItemActive: (libraryItemId: string) => boolean,
  libraryItemId: string
): Promise<StrandedOutcome> {
  if (itemsBeingReplayed.has(libraryItemId) || isItemActive(libraryItemId) || !isStranded(storage.read(libraryItemId))) return 'skipped'
  itemsBeingReplayed.add(libraryItemId)
  try {
    const session = await api.startSession(libraryItemId, startOptions)

    // Re-validate after the await: the user may have started playing this very item, or the record
    // may have been pushed/cleared by someone else. The live player owns an active item.
    const record = storage.read(libraryItemId)
    if (!isStranded(record) || isItemActive(libraryItemId)) {
      await closeProbeSession(api, session)
      return 'skipped'
    }

    // The server is already at or past this position (another device listened further): nothing to
    // correct, and sending a lower position would rewind it. The leftover counter can never be
    // delivered usefully, so it is dropped; otherwise this item would open a session on every run.
    if (record.currentTime <= session.currentTime) {
      await closeProbeSession(api, session)
      subtractReported(storage, libraryItemId, record.unsyncedTimeListened)
      return 'settled'
    }

    await api.closeSession(session.id, { currentTime: record.currentTime, timeListened: record.unsyncedTimeListened })
    subtractReported(storage, libraryItemId, record.unsyncedTimeListened)
    return 'pushed'
  } finally {
    itemsBeingReplayed.delete(libraryItemId)
  }
}

export interface ReplayAllOptions {
  storage?: OfflineProgressStorage
  /** True for an item the live player owns (loaded or about to load). Its own progress sync is the
   * single writer for it, so it is left out of the replay. Re-checked after the session request. */
  isItemActive?: (libraryItemId: string) => boolean
}

/** Pushes every stranded offline record to the server, one item at a time; best-effort, never
 * throws. Resolves to the number of items whose listening the server accepted.
 *
 * Skips `server-cache` snapshots, items with nothing unsynced, and the active item. Stops at the
 * first sign the server is unreachable (network error, timeout, 5xx, 401, 429) rather than waiting
 * out a timeout per remaining item; a 4xx specific to one item (e.g. 404) skips just that item.
 * Everything not pushed keeps its record untouched for the next run. */
export async function replayAllUnsyncedOfflineProgress(
  api: Pick<AbsClient, 'startSession' | 'closeSession'>,
  startOptions: StartSessionOptions,
  options: ReplayAllOptions = {}
): Promise<number> {
  let pushed = 0
  try {
    const storage = options.storage ?? localOfflineProgressStorage
    const isItemActive = options.isItemActive ?? (() => false)
    for (const { libraryItemId } of storage.listUnsynced()) {
      try {
        if ((await pushStrandedItem(api, startOptions, storage, isItemActive, libraryItemId)) === 'pushed') pushed++
      } catch (error) {
        if (!isPerItemFailure(error)) break
      }
    }
  } catch {
    // A replay must never surface into the UI.
  }
  return pushed
}

export interface OfflineProgressReplayerOptions extends ReplayAllOptions {
  now?: () => number
  minIntervalMs?: number
}

export interface OfflineProgressReplayer {
  /** Replays all stranded records unless a run is already in flight (the same promise is returned)
   * or, without `force`, the last run started less than `minIntervalMs` ago. `force` is for the
   * network coming back, which must not be swallowed by an earlier failed attempt. Never rejects. */
  run(options?: { force?: boolean }): Promise<number>
}

/** Single-flight, throttled front for `replayAllUnsyncedOfflineProgress`; the thing lifecycle
 * triggers (startup, foreground, network-online) call. Does nothing, and costs no request, when no
 * record has unsynced listening. */
export function createOfflineProgressReplayer(
  api: Pick<AbsClient, 'startSession' | 'closeSession'>,
  startOptions: StartSessionOptions,
  options: OfflineProgressReplayerOptions = {}
): OfflineProgressReplayer {
  const now = options.now ?? Date.now
  const minIntervalMs = options.minIntervalMs ?? OFFLINE_REPLAY_MIN_INTERVAL_MS
  const storage = options.storage ?? localOfflineProgressStorage
  let inFlight: Promise<number> | null = null
  let lastStartedAt: number | null = null

  return {
    run({ force = false } = {}) {
      try {
        if (inFlight) return inFlight
        if (!force && lastStartedAt !== null && now() - lastStartedAt < minIntervalMs) return Promise.resolve(0)
        if (storage.listUnsynced().length === 0) return Promise.resolve(0)
        lastStartedAt = now()
        const running = replayAllUnsyncedOfflineProgress(api, startOptions, options).finally(() => {
          inFlight = null
        })
        inFlight = running
        return running
      } catch {
        return Promise.resolve(0)
      }
    }
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
 * - `flush`: writes the local record now (ignoring the throttle) and flushes `wrapped`, without
 *   closing anything -- used when the app is backgrounded but audio keeps playing. NEVER rejects.
 * - `close`: flushes the local record first, then closes `wrapped`. NEVER rejects --
 *   `PlayerProvider.teardownNative` relies on that (see its contract comment).
 *
 * Snapshots with no duration yet are not persisted: the native player has not finished preparing,
 * so its position is not the resume position and writing it would clobber the saved one with ~0.
 */
export function createOfflineProgressSync(libraryItemId: string, wrapped: NativeProgressSync | null = null, options: OfflineProgressSyncOptions = {}): NativeProgressSync {
  const storage = options.storage ?? localOfflineProgressStorage
  const now = options.now ?? Date.now

  // Listening accrued by THIS sync that is not in the store yet. The store, not this closure, owns
  // the running total (whatever an earlier offline session left is already in it), so a replay that
  // delivers and zeroes the stored counter while this item is loaded is respected instead of being
  // overwritten by a stale in-memory copy -- which would report the same time a second time.
  let pendingListened = 0
  let latest: { currentTime: number; duration: number } | null = null
  let latestStatus: PlayerStatus | null = null
  let lastWrittenAt: number | null = null
  let lastWrittenStatus: PlayerStatus | null = null
  let previous: { currentTime: number; status: PlayerStatus; at: number } | null = null
  let closed = false

  function persist(at: number): void {
    if (!latest) return
    const stored = storage.read(libraryItemId)?.unsyncedTimeListened ?? 0
    storage.write(libraryItemId, { currentTime: latest.currentTime, duration: latest.duration, unsyncedTimeListened: stored + pendingListened, updatedAt: at })
    // `write` never throws and may silently drop (quota): only forget the pending time once it is
    // seen to have landed, so a dropped write is retried by the next persist instead of lost.
    if (pendingListened > 0 && storage.read(libraryItemId)?.updatedAt === at) pendingListened = 0
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
    pendingListened += Math.min(advanced, elapsedSeconds * rate + 1)
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

    async flush(): Promise<void> {
      // Bypasses the write throttle on purpose: the app is leaving the foreground, so the
      // throttled 5 s cadence may not get another chance to run before Android freezes the WebView.
      // Unlike close() it leaves the record open -- playback continues and `observe` keeps writing.
      if (!closed) {
        try {
          persist(now())
        } catch {
          // Local bookkeeping is best-effort and must never block the server flush below.
        }
      }
      try {
        await wrapped?.flush()
      } catch {
        // Same contract as close(): the server may be unreachable, and callers never see a rejection.
      }
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
