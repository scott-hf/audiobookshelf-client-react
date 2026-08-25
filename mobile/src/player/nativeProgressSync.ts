import type { AbsClient } from '../api/absClient'
import type { PlayerSnapshot } from './playerTypes'

// Matches HtmlAudioPlayer's SYNC_INTERVAL_MS -- kept as a separate constant rather than a shared
// import since the two players don't share an interface (see Task 1's flagged divergence note).
const SYNC_INTERVAL_MS = 15_000

export interface NativeProgressSync {
  /** Called on every native `playerState` snapshot (see PlayerProvider's subscribe wiring).
   * Starts/stops the periodic sync timer based on play state and syncs immediately on pause. */
  observe(snapshot: PlayerSnapshot): void
  /** Explicit stop / item replacement / app-background: stop syncing and report final progress. */
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

  function stopTimer(): void {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  function syncNow(): void {
    const timeListened = Math.max(0, lastKnownTime - lastSyncedAt)
    lastSyncedAt = lastKnownTime
    if (timeListened > 0) {
      void api.syncSession(sessionId, { currentTime: lastKnownTime, timeListened })
    }
  }

  function startTimer(): void {
    stopTimer()
    timer = setInterval(syncNow, SYNC_INTERVAL_MS)
  }

  return {
    observe(snapshot: PlayerSnapshot): void {
      lastKnownTime = snapshot.currentTime

      if (snapshot.status === 'playing') {
        if (timer === null) startTimer()
      } else if (snapshot.status === 'paused') {
        if (timer !== null) {
          stopTimer()
          syncNow()
        }
      } else if (snapshot.status === 'ended' || snapshot.status === 'error') {
        stopTimer()
      }
    },

    async close(): Promise<void> {
      stopTimer()
      const timeListened = Math.max(0, lastKnownTime - lastSyncedAt)
      await api.closeSession(sessionId, { currentTime: lastKnownTime, timeListened })
    }
  }
}
