import type { AbsClient } from '../api/absClient'
import type { PlayerSnapshot } from './playerTypes'

// Matches HtmlAudioPlayer's SYNC_INTERVAL_MS -- kept as a separate constant rather than a shared
// import since the two players don't share an interface (see Task 1's flagged divergence note).
const SYNC_INTERVAL_MS = 15_000

export interface NativeProgressSync {
  /** Called on every native `playerState` snapshot (see PlayerProvider's subscribe wiring).
   * Starts/stops the periodic sync timer based on play state and syncs immediately on pause. */
  observe(snapshot: PlayerSnapshot): void
  /** Reports the current position now WITHOUT ending the session or stopping the sync timer: used
   * when the app is backgrounded but audio keeps playing. A backgrounded WebView has its timers
   * throttled or suspended by Android, so the 15 s interval cannot be relied on to run again until
   * the app returns -- this pushes whatever progress exists at the moment the app leaves the
   * foreground.
   *
   * NEVER rejects, exactly like `close()` (and for the same reason: callers sit on teardown/lifecycle
   * paths where a server hiccup must not become an unhandled rejection). A failed report is dropped;
   * the next sync carries the then-current position. */
  flush(): Promise<void>
  /** Explicit stop / item replacement: stop syncing and report final progress. (App-background no
   * longer closes -- audio keeps playing -- it `flush()`es instead.) */
  close(): Promise<void>
}

/**
 * ABS progress-sync ownership for the native player: the native (Kotlin/ExoPlayer) side only
 * reports position/play-state snapshots (per the Task 1 contract note) -- this module is what
 * actually calls `AbsClient.syncSession`/`closeSession`, mirroring `HtmlAudioPlayer`'s internal
 * sync timer but driven by native snapshots instead of an `<audio>` element.
 */
export function createNativeProgressSync(api: AbsClient, sessionId: string): NativeProgressSync {
  let timer: ReturnType<typeof setInterval> | null = null
  let lastSyncedAt = 0
  let lastKnownTime = 0
  let closed = false

  function stopTimer(): void {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  /** Reports progress since the last report. The request is issued synchronously (an `async`
   * function runs to its first `await` immediately, so a pause still syncs "at once"); the returned
   * promise never rejects, which also stops a failed periodic sync from surfacing as an unhandled
   * rejection out of the interval callback. */
  async function syncNow(): Promise<void> {
    const timeListened = Math.max(0, lastKnownTime - lastSyncedAt)
    lastSyncedAt = lastKnownTime
    if (timeListened <= 0) return
    try {
      await api.syncSession(sessionId, { currentTime: lastKnownTime, timeListened })
    } catch {
      // Best-effort: the server may be unreachable (e.g. the phone just left Wi-Fi). The next sync
      // reports the then-current position.
    }
  }

  function startTimer(): void {
    stopTimer()
    timer = setInterval(() => void syncNow(), SYNC_INTERVAL_MS)
  }

  return {
    observe(snapshot: PlayerSnapshot): void {
      lastKnownTime = snapshot.currentTime

      if (snapshot.status === 'playing') {
        if (timer === null) startTimer()
      } else if (snapshot.status === 'paused') {
        if (timer !== null) {
          stopTimer()
          void syncNow()
        }
      } else if (snapshot.status === 'ended' || snapshot.status === 'error') {
        stopTimer()
      }
    },

    async flush(): Promise<void> {
      // A closed session is gone server-side; reporting to it would only earn a 404.
      if (closed) return
      await syncNow()
    },

    async close(): Promise<void> {
      closed = true
      stopTimer()
      const timeListened = Math.max(0, lastKnownTime - lastSyncedAt)
      await api.closeSession(sessionId, { currentTime: lastKnownTime, timeListened })
    }
  }
}
