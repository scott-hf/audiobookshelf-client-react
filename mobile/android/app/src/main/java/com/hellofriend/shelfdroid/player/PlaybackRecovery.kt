package com.hellofriend.shelfdroid.player

import com.hellofriend.shelfdroid.data.PlaybackSession

/**
 * Pure decisions about what [PlayerNotificationService] writes to [PlaybackStateStore], kept free
 * of `android.*` so they are JVM-unit-testable (same split as [PlayerStateReducer]).
 *
 * Neither function ever includes the access token: [StoredPlaybackState] has no field for it, and
 * the JS side re-reads the current one from `SecureSessionPlugin` when it resumes.
 */
object PlaybackRecovery {
    /** The recovery snapshot for a live (state-change or tick) [snapshot], or null when nothing is
     * recoverable: ended/error/idle statuses mean "clear the store", and no session means there is
     * nothing to describe. `shouldResume` records that the player was actually playing. */
    fun liveState(snapshot: PlayerSnapshot, session: PlaybackSession?, serverUrl: String, nowMs: Long): StoredPlaybackState? {
        when (snapshot.status) {
            PlayerStatus.PLAYING, PlayerStatus.BUFFERING, PlayerStatus.PAUSED -> Unit
            else -> return null
        }
        val live = session ?: return null
        return StoredPlaybackState(
            sessionId = live.id,
            libraryItemId = live.id,
            sessionJson = PlaybackStateStore.sessionToJson(live),
            positionMs = snapshot.currentTimeMs,
            rate = snapshot.rate,
            shouldResume = snapshot.status == PlayerStatus.PLAYING,
            serverUrlFingerprint = serverUrl,
            updatedAt = nowMs
        )
    }

    /** The FINAL recovery snapshot when the user removes the app from recents.
     *
     * Written at that moment because the WebView is being torn down with the task, so JS can no
     * longer sync progress -- this store is the only record of where the user got to, and the next
     * cold start reads it back via `restoreRecoveryState`. [livePositionMs] is the player's position
     * right now, which can be up to a tick (500 ms) or the persist throttle (5 s) ahead of what
     * [lastSnapshot] carries.
     *
     * Returns null when the last known status was not recoverable (ended/error/idle): those already
     * cleared the store on purpose, and a task removal must not resurrect a finished or failed
     * session. `shouldResume` is always false -- playback is being stopped, so a restart must not
     * be treated as "was playing, continue". */
    fun taskRemovedState(lastSnapshot: PlayerSnapshot, session: PlaybackSession?, livePositionMs: Long, serverUrl: String, nowMs: Long): StoredPlaybackState? {
        val state = liveState(lastSnapshot, session, serverUrl, nowMs) ?: return null
        return state.copy(positionMs = livePositionMs.coerceAtLeast(0), shouldResume = false)
    }
}
