package com.hellofriend.shelfdroid.player

import com.google.android.exoplayer2.MediaItem
import com.google.android.exoplayer2.ext.cast.CastPlayer
import com.google.android.exoplayer2.ext.cast.SessionAvailabilityListener
import com.google.android.gms.cast.framework.CastContext

/**
 * Thin app-level adapter around the OFFICIAL `com.google.android.exoplayer:extension-cast`
 * artifact's `com.google.android.exoplayer2.ext.cast.CastPlayer` (WI-1496 t900 Task 3) --
 * exposes only the play/pause/seek/load surface [CastManager] needs, matching
 * `PlayerNotificationService`'s own command vocabulary (t700) instead of the SDK's full
 * ExoPlayer `Player` interface. Deliberately NOT a reimplementation of the SDK's
 * `CastPlayer`/`Timeline`/track-selection internals -- see [CastManager]'s class doc for why the
 * donor app's local fork of those (its own `player/CastPlayer.kt`, 1019 lines,
 * `CastTimeline.kt`, `CastTimelineTracker.kt`, `CastTrackSelection.kt`) was not ported line for
 * line.
 */
class CastPlaybackController(castContext: CastContext) {
    private val player = CastPlayer(castContext)

    fun setSessionAvailabilityListener(listener: SessionAvailabilityListener?) {
        player.setSessionAvailabilityListener(listener)
    }

    /** Loads [descriptor] and starts playback at its `startPositionMs` -- the JS `castHandoff.ts`
     * controller is what resolves that position from the native player's last snapshot; this
     * method never queries native playback state itself. */
    fun loadMedia(descriptor: CastMediaDescriptor) {
        val mediaItem = MediaItem.Builder()
            .setUri(descriptor.contentUrl)
            .setMimeType(descriptor.contentType)
            .setMediaMetadata(
                com.google.android.exoplayer2.MediaMetadata.Builder().setTitle(descriptor.title).build()
            )
            .build()
        player.setMediaItem(mediaItem, descriptor.startPositionMs)
        player.prepare()
        player.playWhenReady = true
    }

    fun play() {
        player.playWhenReady = true
    }

    fun pause() {
        player.playWhenReady = false
    }

    fun seekTo(positionMs: Long) {
        player.seekTo(positionMs)
    }

    fun currentPositionMs(): Long = player.currentPosition

    fun release() {
        player.setSessionAvailabilityListener(null)
        player.release()
    }
}
