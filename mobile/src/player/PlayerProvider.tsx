import { App as CapacitorApp } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import { createContext, ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthProvider'
import { useDownloads } from '../downloads/DownloadProvider'
import AbsAudioPlayerNative from '../native/absAudioPlayerPlugin'
import CastNative from '../native/castPlugin'
import { createCastHandoffController, CastHandoffController, CastSessionSource } from './castHandoff'
import { HtmlAudioPlayer } from './htmlAudioPlayer'
import { createNativeAudioPlayer } from './nativeAudioPlayer'
import { createNativeProgressSync, NativeProgressSync } from './nativeProgressSync'
import { LocalTrack, parseLocalManifest, selectPlaybackSource } from './offlineSource'
import { INITIAL_PLAYER_STATE, PlayerSnapshot, PlayerState } from './playerTypes'

const DEVICE_ID = 'shelfdroid-android'
const DEFAULT_JUMP_FORWARD_SECONDS = 30
const DEFAULT_JUMP_BACKWARD_SECONDS = 10

export interface PlayerContextValue {
  state: PlayerState
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

  const progressSyncRef = useRef<NativeProgressSync | null>(null)
  const itemIdRef = useRef<string | null>(null)
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
      setState({
        status: snapshot.status,
        itemId: itemIdRef.current,
        currentTime: snapshot.currentTime,
        duration: snapshot.duration,
        error: snapshot.error
      })
      setRateState(snapshot.rate)
      progressSyncRef.current?.observe(snapshot)
    })
  }, [nativePlayer])

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
    if (!nativePlayer) return
    await nativePlayer.stop()
    if (progressSyncRef.current) {
      await progressSyncRef.current.close()
      progressSyncRef.current = null
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
   * next time this item is opened with the server reachable. */
  async function loadOfflineTracks(itemId: string, tracks: LocalTrack[]): Promise<void> {
    if (!nativePlayer) return
    let sessionId = itemId

    try {
      const session = await client.startSession(itemId, {
        deviceInfo: { clientName: 'ShelfDroid', deviceId: DEVICE_ID },
        supportedMimeTypes: ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/flac', 'application/vnd.apple.mpegurl'],
        mediaPlayer: 'exo',
        forceTranscode: false,
        forceDirectPlay: false
      })
      sessionId = session.id
      progressSyncRef.current = createNativeProgressSync(client, session.id)
    } catch {
      // No network / server unreachable -- expected for offline playback. Play unsynced.
    }

    await nativePlayer.load({
      session: { id: sessionId, currentTime: 0, audioTracks: tracks.map((track) => ({ index: track.index, contentUrl: track.contentUrl, duration: track.duration })) },
      accessToken: client.getAccessToken() ?? '',
      serverUrl: client.getServerUrl() ?? ''
    })
  }

  async function play(itemId: string): Promise<void> {
    if (nativePlayer) {
      await closeNative()
      itemIdRef.current = itemId
      setState({ status: 'loading', itemId, currentTime: 0, duration: 0, error: null })

      const local = localItems.find((entry) => entry.libraryItemId === itemId)
      const source = selectPlaybackSource({ id: itemId }, parseLocalManifest(local))

      try {
        if (source.kind === 'offline') {
          // WI-1496 t900 Task 3: offline tracks are local file/content URIs -- not reachable by
          // a Cast receiver (a separate device on the network), so Cast handoff is unavailable
          // for offline playback until a local HTTP relay exists. Left null rather than handed
          // to `cast.load()` with a URI the receiver could never fetch.
          castSourceRef.current = null
          await loadOfflineTracks(itemId, source.tracks)
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
        const accessToken = client.getAccessToken()
        const serverUrl = client.getServerUrl()
        if (!accessToken || !serverUrl) throw new Error('Not authenticated')

        progressSyncRef.current = createNativeProgressSync(client, session.id)
        await nativePlayer.load({ session, accessToken, serverUrl })
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
        setState({ status: 'error', itemId, currentTime: 0, duration: 0, error: error instanceof Error ? error.message : 'Playback failed' })
        throw error
      }
      return
    }
    await htmlPlayer?.play(itemId)
  }

  function pause(): void {
    if (nativePlayer) {
      void nativePlayer.pause()
      return
    }
    htmlPlayer?.pause()
  }

  async function resume(): Promise<void> {
    if (nativePlayer) {
      await nativePlayer.play()
      return
    }
    await htmlPlayer?.resume()
  }

  function seek(time: number): void {
    if (nativePlayer) {
      void nativePlayer.seek(time)
      return
    }
    htmlPlayer?.seek(time)
  }

  async function close(): Promise<void> {
    if (nativePlayer) {
      await closeNative()
      return
    }
    await htmlPlayer?.close()
  }

  function setRate(nextRate: number): void {
    if (nativePlayer) {
      void nativePlayer.setRate(nextRate)
      setRateState(nextRate)
    }
    // HtmlAudioPlayer doesn't implement rate control yet -- no-op on web.
  }

  function jumpForward(seconds = DEFAULT_JUMP_FORWARD_SECONDS): void {
    seek(state.currentTime + seconds)
  }

  function jumpBackward(seconds = DEFAULT_JUMP_BACKWARD_SECONDS): void {
    seek(Math.max(0, state.currentTime - seconds))
  }

  async function connectCast(): Promise<void> {
    await castHandoff?.connectCast()
  }

  function isCasting(): boolean {
    return castHandoff?.isCasting() ?? false
  }

  function setSleepTimer(seconds: number | null): void {
    if (nativePlayer) {
      void nativePlayer.setSleepTimer(seconds)
    }
    // No sleep timer support on the web/dev-preview path.
  }

  const value = useMemo<PlayerContextValue>(
    () => ({ state, rate, play, pause, resume, seek, close, setRate, jumpForward, jumpBackward, setSleepTimer, connectCast, isCasting }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, rate, htmlPlayer, nativePlayer, castHandoff, client]
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
