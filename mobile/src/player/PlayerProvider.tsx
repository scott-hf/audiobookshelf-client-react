import { App as CapacitorApp } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import { createContext, ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useTypeSafeTranslations } from '@/hooks/useTypeSafeTranslations'
import { useAuth } from '../auth/AuthProvider'
import { useDownloads } from '../downloads/DownloadProvider'
import AbsAudioPlayerNative from '../native/absAudioPlayerPlugin'
import CastNative from '../native/castPlugin'
import { createCastHandoffController, CastHandoffController, CastSessionSource } from './castHandoff'
import { HtmlAudioPlayer } from './htmlAudioPlayer'
import { createNativeAudioPlayer } from './nativeAudioPlayer'
import { createNativeProgressSync, NativeProgressSync } from './nativeProgressSync'
import { createOfflineProgressSync, localOfflineProgressStorage, replayUnsyncedOfflineProgress, resolveOfflineStartTime } from './offlineProgress'
import { LocalTrack, parseLocalManifest, selectPlaybackSource } from './offlineSource'
import { INITIAL_PLAYER_STATE, PlayerSnapshot, PlayerState } from './playerTypes'

const DEVICE_ID = 'shelfdroid-android'
const DEFAULT_JUMP_FORWARD_SECONDS = 30
const DEFAULT_JUMP_BACKWARD_SECONDS = 10
/** A `loading` state (session start + native load) that outlasts this becomes an `error`, so a hung
 * request cannot leave every control disabled forever. Longer than the session-start request
 * timeout (absClient's SESSION_START_TIMEOUT_MS) so a plain slow server surfaces its own error first. */
export const LOADING_TIMEOUT_MS = 30_000
/** Buffering with intent to play for longer than this is reported as `stalled` so the UI can say so
 * instead of showing a bare "Buffering…" indefinitely. */
export const STALL_THRESHOLD_MS = 15_000
/** How long an explicit close() waits for the ABS session-close request before moving on. */
const CLOSE_SESSION_WAIT_MS = 3_000

/** Capacitor rejections are not always `Error` instances (the native bridge can reject with a
 * plain `{ message }` object), so pull a message out of whatever was thrown. */
function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string' && error.message) return error.message
  return fallback
}

export interface PlayerContextValue {
  state: PlayerState
  /** True once the player has been buffering with intent to play for STALL_THRESHOLD_MS. */
  stalled: boolean
  /** Live playback rate; only the native player actually varies it (HtmlAudioPlayer's
   * <audio>.playbackRate is not wired up in the milestone-one web path). Exposed regardless
   * of platform so PlayerPage doesn't need to branch on `Capacitor.isNativePlatform()` itself. */
  rate: number
  play: (itemId: string) => Promise<void>
  pause: () => void
  resume: () => Promise<void>
  seek: (time: number) => void
  close: () => Promise<void>
  /** No-ops on the web/dev-preview path (HtmlAudioPlayer doesn't implement them yet) -- see the
   * Task 1 contract note on the divergence between HtmlAudioPlayer and the native adapter. */
  setRate: (rate: number) => void
  jumpForward: (seconds?: number) => void
  jumpBackward: (seconds?: number) => void
  setSleepTimer: (seconds: number | null) => void
  /** No-op on the web/dev-preview path -- Chromecast handoff (WI-1496 t900 Task 3) only applies
   * to the native player. `connectCast` is a no-op if nothing is currently loaded. */
  connectCast: () => Promise<void>
  isCasting: () => boolean
}

export const PlayerContext = createContext<PlayerContextValue | null>(null)

export function PlayerProvider({ children }: { children: ReactNode }) {
  const { client } = useAuth()
  // WI-1496 t800 Task 5: `DownloadProvider` is always an ancestor of `PlayerProvider` (see
  // App.tsx's provider nesting) -- reading `localItems` here, rather than requiring every `play()`
  // caller to look it up and pass it in, is what lets `play(itemId)` transparently choose offline
  // vs stream without every call site (PlayerPage, the offline catalog's "Play offline" button)
  // needing to duplicate that decision.
  const { localItems } = useDownloads()
  const isNative = useMemo(() => Capacitor.isNativePlatform(), [])
  const t = useTypeSafeTranslations()

  const htmlPlayer = useMemo(() => (isNative ? null : new HtmlAudioPlayer({ api: client })), [client, isNative])
  const nativePlayer = useMemo(() => (isNative ? createNativeAudioPlayer(AbsAudioPlayerNative) : null), [isNative])
  // WI-1496 t900 Task 3: built directly on the raw `AbsAudioPlayerPlugin` bridge (not the
  // `nativePlayer` wrapper) -- the handoff controller needs the same low-level
  // getState/pause/seek surface the bridge exposes, matching `castHandoff.ts`'s contract.
  const castHandoff = useMemo<CastHandoffController | null>(
    () => (isNative ? createCastHandoffController(AbsAudioPlayerNative, CastNative, () => castSourceRef.current) : null),
    [isNative]
  )

  const [state, setState] = useState<PlayerState>(INITIAL_PLAYER_STATE)
  const [rate, setRateState] = useState(1)
  const [stalled, setStalled] = useState(false)
  // Error from a transport command (play/pause/seek/...) that was rejected by the native bridge.
  // Kept apart from `state.error` because every native snapshot (now ticking twice a second)
  // replaces `state` wholesale and would wipe it immediately.
  const [actionError, setActionError] = useState<string | null>(null)
  // Latest committed state for event handlers: jump/seek must work from the current position, not
  // from whatever `state` the memoized context value happened to close over.
  const stateRef = useRef<PlayerState>(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])

  const progressSyncRef = useRef<NativeProgressSync | null>(null)
  const itemIdRef = useRef<string | null>(null)
  /**
   * Incremented by every `play()` and `close()` so an in-flight native `play()` can detect that
   * it has been superseded and hand back whatever it already acquired.
   *
   * Same race `HtmlAudioPlayer.playGeneration` guards (see htmlAudioPlayer.ts): two overlapping
   * `play()` calls each `await client.startSession(...)`, then each overwrite
   * `progressSyncRef.current`. Unlike the web path there is only one ExoPlayer, so audio does
   * not double up -- but the first ABS session is dropped without ever being synced or closed,
   * leaking an open session on the server.
   */
  const playGenerationRef = useRef(0)
  // WI-1496 t900 Task 3: the currently-loaded stream's Cast-load source, kept in lockstep with
  // whatever was last handed to `nativePlayer.load()` (stream or offline) -- `castHandoff`'s
  // `connectCast()` reads this instead of re-resolving a session, preserving the ONE ABS
  // session invariant.
  const castSourceRef = useRef<CastSessionSource | null>(null)

  // Web path: HtmlAudioPlayer owns its own PlayerState and sync timer -- just relay it.
  useEffect(() => {
    if (!htmlPlayer) return
    return htmlPlayer.subscribe(setState)
  }, [htmlPlayer])

  // Native path: the native side only reports position/play-state snapshots (per the Task 1
  // contract note) -- React owns ABS session start/sync/close via nativeProgressSync.
  useEffect(() => {
    if (!nativePlayer) return
    return nativePlayer.subscribe((snapshot: PlayerSnapshot) => {
      setState((previous) => ({
        status: snapshot.status,
        itemId: itemIdRef.current,
        // Keep the seeded offline resume position visible through the pre-roll. `load()` emits a
        // `loading`/`buffering` snapshot with `currentTime: 0` before ExoPlayer has seeked to the
        // session's start position, which would otherwise flash the restored position back to
        // 0:00 right after play() seeded it (see the offline start-time resolution below).
        // Transient by construction: the first snapshot carrying a real position wins, because a
        // seeked player reports its actual position rather than 0.
        currentTime: snapshot.currentTime === 0 && previous.currentTime > 0 && (snapshot.status === 'loading' || snapshot.status === 'buffering') ? previous.currentTime : snapshot.currentTime,
        duration: snapshot.duration,
        error: snapshot.error,
        playWhenReady: snapshot.playWhenReady
      }))
      setRateState(snapshot.rate)
      progressSyncRef.current?.observe(snapshot)
    })
  }, [nativePlayer])

  // Stall watchdog: buffering *with intent to play* that outlasts STALL_THRESHOLD_MS is surfaced
  // so the UI can say so. Keyed on the status/intent transition, not on each snapshot, so the
  // native position ticks do not restart the clock.
  const buffering = state.status === 'buffering' && state.playWhenReady
  useEffect(() => {
    if (!buffering) return
    const timer = setTimeout(() => setStalled(true), STALL_THRESHOLD_MS)
    return () => {
      clearTimeout(timer)
      setStalled(false)
    }
  }, [buffering])

  // Loading watchdog (native path): a hung session request / native load becomes an error after
  // LOADING_TIMEOUT_MS instead of leaving every control disabled. Bumping the generation makes the
  // hung play() hand back whatever it eventually acquires rather than installing it.
  const loading = state.status === 'loading'
  useEffect(() => {
    if (!nativePlayer || !loading) return
    const timer = setTimeout(() => {
      playGenerationRef.current++
      setState((previous) => ({ ...INITIAL_PLAYER_STATE, status: 'error', itemId: previous.itemId, error: t('MessagePlayerLoadTimeout') }))
    }, LOADING_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [nativePlayer, loading, t])

  useEffect(() => {
    // Close (not just pause) on app background per the vertical-slice spec -- the sync
    // timer cannot run while backgrounded, so we report final progress immediately instead.
    const listenerHandle = CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) void close()
    })
    return () => {
      void listenerHandle.then((handle) => handle.remove())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // WI-1496 t700 Task 4: pick up a session PlayerNotificationService restored from
  // PlaybackStateStore (process death / service recreation) instead of assuming idle on cold
  // start. This only reflects the recovered position/status for display -- it does not rebuild
  // an ExoPlayer media source or resume audio (no token is persisted natively; the user re-enters
  // the item via `play()` to actually resume playback, which reloads a fresh session + token).
  useEffect(() => {
    if (!nativePlayer) return
    let cancelled = false
    // Calls the plugin directly (not `nativePlayer.getState()`, which only returns the
    // in-memory snapshot already tracked from `playerState` events and is synchronous) -- this
    // needs the async round trip to the native side to observe state restored before any
    // `playerState` event has fired yet.
    AbsAudioPlayerNative.getState()
      .then((snapshot: PlayerSnapshot) => {
        if (cancelled || snapshot.status === 'idle' || !snapshot.itemId) return
        itemIdRef.current = snapshot.itemId
        setState(snapshot)
        setRateState(snapshot.rate)
      })
      .catch(() => {
        // Service not bound yet or nothing to recover -- fine, stay idle.
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nativePlayer])

  async function closeNative(): Promise<void> {
    // Supersede any in-flight play() so it releases its own session instead of installing it
    // after we have already cleaned up.
    playGenerationRef.current++
    await teardownNative({ waitForClose: true })
  }

  /** Releases the native player and the current ABS session. Does not touch `playGenerationRef`
   * -- callers decide whether they are superseding an in-flight play().
   *
   * Never rejects and never waits unboundedly on the server: a failed `stop()` is moot because the
   * next `load()` (or the user's close) surfaces any real problem, and the ABS session close is
   * fire-and-forget (`waitForClose: false`, used when replacing an item so a slow/dead server
   * cannot block the new load) or time-boxed (`waitForClose: true`, used by an explicit close()). */
  async function teardownNative({ waitForClose }: { waitForClose: boolean }): Promise<void> {
    if (!nativePlayer) return
    const sync = progressSyncRef.current
    progressSyncRef.current = null
    try {
      await nativePlayer.stop()
    } catch {
      // Service not bound / already stopped -- nothing to release.
    }
    if (sync) {
      const closing = sync.close().catch(() => {
        // Best-effort: the server may already have closed it, or be unreachable.
      })
      if (waitForClose) await Promise.race([closing, new Promise<void>((resolve) => setTimeout(resolve, CLOSE_SESSION_WAIT_MS))])
    }
    itemIdRef.current = null
    castSourceRef.current = null
    setState({ ...INITIAL_PLAYER_STATE })
  }

  /** WI-1496 t800 Task 5: plays a complete local download's tracks by URI instead of the ABS
   * stream. Still tries to open/sync a real ABS session first (progress reconciliation once
   * online) via the same `nativeProgressSync` plumbing the stream path uses -- but unlike the
   * stream path, a failure to reach the server (offline/airplane-mode, the whole point of offline
   * playback) is not fatal: playback proceeds unsynced, using the item id itself as a stable
   * session identifier for the player's own state, and progress simply doesn't sync until the
   * next time this item is opened with the server reachable.
   *
   * `serverCurrentTime` is the position the server session reports, or null when it fell back to
   * unsynced (no server to ask). The caller combines it with the local offline record
   * (`resolveOfflineStartTime`) -- it is NOT the start position on its own, because after offline
   * listening the server is stale. When a session was obtained, any progress recorded offline is
   * pushed up first (`replayUnsyncedOfflineProgress`; best-effort, never throws). */
  async function startOfflineSession(itemId: string): Promise<{ sessionId: string; sync: NativeProgressSync | null; serverCurrentTime: number | null }> {
    try {
      const session = await client.startSession(itemId, {
        deviceInfo: { clientName: 'ShelfDroid', deviceId: DEVICE_ID },
        supportedMimeTypes: ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/flac', 'application/vnd.apple.mpegurl'],
        mediaPlayer: 'exo',
        forceTranscode: false,
        forceDirectPlay: false
      })
      await replayUnsyncedOfflineProgress(client, session.id, itemId, session.currentTime)
      // Returned rather than assigned to progressSyncRef so the caller can drop it (closing the
      // session) if this play() attempt was superseded while the request was in flight.
      return { sessionId: session.id, sync: createNativeProgressSync(client, session.id), serverCurrentTime: session.currentTime }
    } catch {
      // No network / server unreachable -- expected for offline playback. Play unsynced.
      return { sessionId: itemId, sync: null, serverCurrentTime: null }
    }
  }

  async function loadOfflineTracks(sessionId: string, tracks: LocalTrack[], currentTime: number): Promise<void> {
    if (!nativePlayer) return
    await nativePlayer.load({
      session: { id: sessionId, currentTime, audioTracks: tracks.map((track) => ({ index: track.index, contentUrl: track.contentUrl, duration: track.duration })) },
      accessToken: client.getAccessToken() ?? '',
      serverUrl: client.getServerUrl() ?? ''
    })
  }

  async function play(itemId: string): Promise<void> {
    if (nativePlayer) {
      // Claim this generation first so any already-running play() sees itself superseded.
      const generation = ++playGenerationRef.current
      setActionError(null)

      const local = localItems.find((entry) => entry.libraryItemId === itemId)
      const source = selectPlaybackSource({ id: itemId }, parseLocalManifest(local))

      /**
       * Superseded mid-flight: hand our ABS session back so it is not left open forever.
       *
       * Deliberately does NOT touch the native player. There is only one ExoPlayer and the
       * play() that superseded us already owns it (its teardownNative() stopped it, and it is
       * about to load its own content) -- stopping it here would kill the newer playback.
       * The close is best-effort: if the newer teardown already closed this session the server
       * rejects the second attempt, which is harmless and must not surface as a playback error.
       */
      const abandon = async (sync: NativeProgressSync | null): Promise<void> => {
        if (!sync) return
        try {
          await sync.close()
        } catch {
          // Already closed by the superseding teardown -- nothing left to release.
        }
      }

      try {
        // Inside the try so a failure here lands in the error state (with a retry path) rather
        // than escaping with the UI stuck on whatever state preceded it.
        await teardownNative({ waitForClose: false })
        if (generation !== playGenerationRef.current) return

        // Read AFTER teardownNative: closing the previous playback flushes its local record, and
        // re-opening the same item must see that flush. Only offline playback keeps a local record
        // (a downloaded item always resolves to `source.kind === 'offline'`), so the stream path
        // has nothing to seed.
        const localProgress = source.kind === 'offline' ? localOfflineProgressStorage.read(itemId) : null

        itemIdRef.current = itemId
        // Seeded from the local record so the UI shows the resume position while loading instead
        // of flashing 0:00 (the native snapshots take over once the player is ready).
        setState({ ...INITIAL_PLAYER_STATE, status: 'loading', itemId, currentTime: localProgress?.currentTime ?? 0 })

        if (source.kind === 'offline') {
          // WI-1496 t900 Task 3: offline tracks are local file/content URIs -- not reachable by
          // a Cast receiver (a separate device on the network), so Cast handoff is unavailable
          // for offline playback until a local HTTP relay exists. Left null rather than handed
          // to `cast.load()` with a URI the receiver could never fetch.
          castSourceRef.current = null

          const { sessionId, sync, serverCurrentTime } = await startOfflineSession(itemId)
          if (generation !== playGenerationRef.current) return await abandon(sync)

          // max(server, local), not "prefer the server": after offline listening the server is
          // stale and preferring it would rewind the user, then overwrite their real progress.
          await loadOfflineTracks(sessionId, source.tracks, resolveOfflineStartTime(serverCurrentTime, localProgress))
          if (generation !== playGenerationRef.current) return await abandon(sync)

          // Always populated for offline playback (even with no server session) so a local record
          // is kept whether or not the server is reachable -- that is what makes the NEXT offline
          // resume work. `sync` is the server sync it wraps, or null when unsynced.
          progressSyncRef.current = createOfflineProgressSync(itemId, sync)
          await nativePlayer.play()
          return
        }

        const session = await client.startSession(itemId, {
          deviceInfo: { clientName: 'ShelfDroid', deviceId: DEVICE_ID },
          supportedMimeTypes: ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/flac', 'application/vnd.apple.mpegurl'],
          mediaPlayer: 'exo',
          forceTranscode: false,
          forceDirectPlay: false
        })
        const sync = createNativeProgressSync(client, session.id)
        if (generation !== playGenerationRef.current) return await abandon(sync)

        const accessToken = client.getAccessToken()
        const serverUrl = client.getServerUrl()
        if (!accessToken || !serverUrl) throw new Error('Not authenticated')

        progressSyncRef.current = sync
        await nativePlayer.load({ session, accessToken, serverUrl })
        if (generation !== playGenerationRef.current) return await abandon(sync)

        // WI-1496 t900 Task 3: only the first track's URL is castable -- multi-track (chaptered)
        // sessions would need a Cast queue to hand off every track, out of this task's scope
        // (see report GAPS). Single-track sessions (the common case) hand off correctly.
        const firstTrack = [...session.audioTracks].sort((a, b) => a.index - b.index)[0]
        castSourceRef.current = firstTrack
          ? {
              contentUrl: /^https?:\/\//.test(firstTrack.contentUrl) ? firstTrack.contentUrl : `${serverUrl}${firstTrack.contentUrl}`,
              contentType: 'audio/mpeg',
              title: itemId,
              accessToken
            }
          : null
        await nativePlayer.play()
      } catch (error) {
        // A superseded attempt must not clobber the newer attempt's state or surface its failure.
        if (generation !== playGenerationRef.current) return
        setState({ ...INITIAL_PLAYER_STATE, status: 'error', itemId, error: errorMessage(error, 'Playback failed') })
        throw error
      }
      return
    }
    await htmlPlayer?.play(itemId)
  }

  /** Optimistic local `playWhenReady`: flips the intent immediately on tap so the button reflects
   * it without waiting on the native round trip; the next native snapshot reconciles it. */
  function setPlayWhenReady(playWhenReady: boolean): void {
    stateRef.current = { ...stateRef.current, playWhenReady }
    setState((previous) => (previous.status === 'idle' ? previous : { ...previous, playWhenReady }))
  }

  /** Runs a native transport command, surfacing a rejection (e.g. "Native player service not bound
   * yet") through `actionError` instead of discarding it; `revert` undoes any optimistic update. */
  async function runNativeCommand(command: Promise<void>, fallback: string, revert?: () => void): Promise<void> {
    setActionError(null)
    try {
      await command
    } catch (error) {
      revert?.()
      setActionError(errorMessage(error, fallback))
    }
  }

  function pause(): void {
    if (nativePlayer) {
      const previous = stateRef.current.playWhenReady
      setPlayWhenReady(false)
      void runNativeCommand(nativePlayer.pause(), 'Could not pause playback', () => setPlayWhenReady(previous))
      return
    }
    htmlPlayer?.pause()
  }

  async function resume(): Promise<void> {
    if (nativePlayer) {
      const previous = stateRef.current.playWhenReady
      setPlayWhenReady(true)
      await runNativeCommand(nativePlayer.play(), 'Could not start playback', () => setPlayWhenReady(previous))
      return
    }
    try {
      await htmlPlayer?.resume()
    } catch (error) {
      setActionError(errorMessage(error, 'Could not start playback'))
    }
  }

  function seek(time: number): void {
    if (nativePlayer) {
      // Optimistic position too: back-to-back jumps must build on each other, not on the last
      // native snapshot.
      stateRef.current = { ...stateRef.current, currentTime: time }
      setState((previous) => ({ ...previous, currentTime: time }))
      void runNativeCommand(nativePlayer.seek(time), 'Could not seek')
      return
    }
    htmlPlayer?.seek(time)
  }

  async function close(): Promise<void> {
    setActionError(null)
    if (nativePlayer) {
      await closeNative()
      return
    }
    await htmlPlayer?.close()
  }

  function setRate(nextRate: number): void {
    if (nativePlayer) {
      void runNativeCommand(nativePlayer.setRate(nextRate), 'Could not change playback speed')
      setRateState(nextRate)
    }
    // HtmlAudioPlayer doesn't implement rate control yet -- no-op on web.
  }

  function jumpForward(seconds = DEFAULT_JUMP_FORWARD_SECONDS): void {
    const { currentTime, duration } = stateRef.current
    const target = currentTime + seconds
    seek(duration > 0 ? Math.min(target, duration) : target)
  }

  function jumpBackward(seconds = DEFAULT_JUMP_BACKWARD_SECONDS): void {
    seek(Math.max(0, stateRef.current.currentTime - seconds))
  }

  async function connectCast(): Promise<void> {
    await castHandoff?.connectCast()
  }

  function isCasting(): boolean {
    return castHandoff?.isCasting() ?? false
  }

  function setSleepTimer(seconds: number | null): void {
    if (nativePlayer) {
      void runNativeCommand(nativePlayer.setSleepTimer(seconds), 'Could not set the sleep timer')
    }
    // No sleep timer support on the web/dev-preview path.
  }

  const visibleState = useMemo<PlayerState>(() => (actionError && !state.error ? { ...state, error: actionError } : state), [state, actionError])

  const value = useMemo<PlayerContextValue>(
    () => ({ state: visibleState, stalled, rate, play, pause, resume, seek, close, setRate, jumpForward, jumpBackward, setSleepTimer, connectCast, isCasting }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visibleState, stalled, rate, htmlPlayer, nativePlayer, castHandoff, client]
  )

  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>
}

export function usePlayer(): PlayerContextValue {
  const value = useContext(PlayerContext)
  if (!value) {
    throw new Error('usePlayer must be used within a PlayerProvider')
  }
  return value
}
