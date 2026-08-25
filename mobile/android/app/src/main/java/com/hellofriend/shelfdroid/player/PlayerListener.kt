package com.hellofriend.shelfdroid.player

import android.util.Log
import com.google.android.exoplayer2.C
import com.google.android.exoplayer2.PlaybackException
import com.google.android.exoplayer2.Player

/** Translates ExoPlayer's [Player.Listener] callbacks into [PlayerEvent]s for [PlayerStateReducer]
 * and forwards each resulting [ReducerResult] to the owning [PlayerNotificationService]. Adapted
 * from the donor app's `PlayerListener.kt`, stripped of widget/cast/DB/sleep-timer/seek-back
 * concerns (out of scope for this milestone -- widget and cast are permanently out of scope per
 * the plan; sleep timer and seek-back land in Task 3). */
class PlayerListener(private val service: PlayerNotificationService) : Player.Listener {
    private val tag = "PlayerListener"
    private val reducer = PlayerStateReducer()

    override fun onPlayerError(error: PlaybackException) {
        val message = error.message ?: "Unknown playback error"
        Log.e(tag, "onPlayerError $message")
        service.applyReducerResult(reducer.reduce(PlayerEvent.Error(message)))
    }

    override fun onEvents(player: Player, events: Player.Events) {
        if (!events.contains(Player.EVENT_PLAYBACK_STATE_CHANGED) && !events.contains(Player.EVENT_IS_PLAYING_CHANGED)) {
            return
        }

        val positionMs = player.currentPosition
        val durationMs = if (player.duration == C.TIME_UNSET) 0L else player.duration
        val rate = player.playbackParameters.speed

        val event = when {
            player.playbackState == Player.STATE_ENDED -> PlayerEvent.Ended(positionMs)
            player.playbackState == Player.STATE_BUFFERING -> PlayerEvent.Buffering(positionMs, durationMs, rate)
            player.isPlaying -> PlayerEvent.Playing(positionMs, durationMs, rate)
            player.playbackState == Player.STATE_READY -> PlayerEvent.Paused(positionMs, durationMs, rate)
            else -> return // STATE_IDLE with nothing loaded yet -- no snapshot to emit
        }

        service.applyReducerResult(reducer.reduce(event))
    }
}
