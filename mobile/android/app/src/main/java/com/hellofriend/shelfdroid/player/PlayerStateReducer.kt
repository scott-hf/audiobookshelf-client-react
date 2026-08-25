package com.hellofriend.shelfdroid.player

/** Mirrors the TS `NativePlayerStatus`/`PlayerStatus` union (mobile/src/player/playerTypes.ts,
 * WI-1496 t700 Task 1) so the Kotlin and TS sides of the bridge agree on the wire vocabulary. */
enum class PlayerStatus { IDLE, LOADING, BUFFERING, PLAYING, PAUSED, ENDED, ERROR }

/** Internal (millisecond-precision) counterpart of the TS `PlayerSnapshot` -- converted to
 * seconds only at the Capacitor JSObject boundary (see plugins/AbsAudioPlayer.kt). */
data class PlayerSnapshot(
    val status: PlayerStatus,
    val currentTimeMs: Long,
    val durationMs: Long,
    val rate: Float,
    val error: String? = null
)

sealed class PlayerEvent {
    data class Buffering(val positionMs: Long, val durationMs: Long, val rate: Float) : PlayerEvent()
    data class Playing(val positionMs: Long, val durationMs: Long, val rate: Float) : PlayerEvent()
    data class Paused(val positionMs: Long, val durationMs: Long, val rate: Float) : PlayerEvent()
    data class Ended(val positionMs: Long) : PlayerEvent()
    data class Error(val message: String) : PlayerEvent()
}

/** Side effects [PlayerNotificationService] must act on for a given reduced [snapshot]:
 * whether to stop the foreground service, and whether to ask the JS side for one final
 * progress sync (JS/`AbsClient` owns ABS progress-sync duties, per the Task 1 contract note --
 * this reducer only signals the need, never syncs itself). */
data class ReducerResult(
    val snapshot: PlayerSnapshot,
    val stopForeground: Boolean,
    val syncFinalProgress: Boolean
)

/**
 * Pure translation of native ExoPlayer/service events into a [PlayerSnapshot], kept free of any
 * `android.*` dependency so it is directly JVM-unit-testable without Robolectric (matches
 * SecureSessionPluginTest's fake-store pattern of a testable core wrapped by a thin
 * Android-facing shell). [PlayerListener] is the only caller in production.
 */
class PlayerStateReducer {
    private var lastDurationMs: Long = 0
    private var lastRate: Float = 1f

    fun reduce(event: PlayerEvent): ReducerResult = when (event) {
        is PlayerEvent.Buffering -> {
            lastDurationMs = event.durationMs
            lastRate = event.rate
            ReducerResult(
                PlayerSnapshot(PlayerStatus.BUFFERING, clamp(event.positionMs, event.durationMs), event.durationMs, event.rate),
                stopForeground = false,
                syncFinalProgress = false
            )
        }
        is PlayerEvent.Playing -> {
            lastDurationMs = event.durationMs
            lastRate = event.rate
            ReducerResult(
                PlayerSnapshot(PlayerStatus.PLAYING, clamp(event.positionMs, event.durationMs), event.durationMs, event.rate),
                stopForeground = false,
                syncFinalProgress = false
            )
        }
        is PlayerEvent.Paused -> {
            lastDurationMs = event.durationMs
            lastRate = event.rate
            ReducerResult(
                PlayerSnapshot(PlayerStatus.PAUSED, clamp(event.positionMs, event.durationMs), event.durationMs, event.rate),
                stopForeground = false,
                syncFinalProgress = true
            )
        }
        is PlayerEvent.Ended -> ReducerResult(
            PlayerSnapshot(PlayerStatus.ENDED, clamp(event.positionMs, lastDurationMs), lastDurationMs, lastRate),
            stopForeground = true,
            syncFinalProgress = true
        )
        is PlayerEvent.Error -> ReducerResult(
            PlayerSnapshot(PlayerStatus.ERROR, 0, lastDurationMs, lastRate, event.message),
            stopForeground = true,
            syncFinalProgress = false
        )
    }

    private fun clamp(position: Long, duration: Long): Long {
        if (duration <= 0) return maxOf(0, position)
        return position.coerceIn(0, duration)
    }
}
