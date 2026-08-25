package com.hellofriend.shelfdroid.player

import android.os.Bundle
import android.support.v4.media.session.MediaSessionCompat
import android.util.Log

/** Adapted from the donor app's `MediaSessionCallback.kt`, stripped of the mediaManager/DB-backed
 * onPrepare/onPlayFromSearch/onPlayFromMediaId handlers and podcast/change-speed custom actions --
 * this milestone always has exactly one already-loaded session (loaded via the plugin's `load`
 * call), never resolves one by search/media-id itself. */
class MediaSessionCallback(private val service: PlayerNotificationService) : MediaSessionCompat.Callback() {
    private val tag = "MediaSessionCallback"

    override fun onPlay() {
        Log.d(tag, "onPlay")
        service.play()
    }

    override fun onPause() {
        Log.d(tag, "onPause")
        service.pause()
    }

    override fun onStop() {
        Log.d(tag, "onStop")
        service.pause()
    }

    override fun onSeekTo(pos: Long) {
        Log.d(tag, "onSeekTo $pos")
        service.seekTo(pos)
    }

    override fun onFastForward() {
        service.jumpForward()
    }

    override fun onRewind() {
        service.jumpBackward()
    }

    override fun onSkipToNext() {
        service.skipToNext()
    }

    override fun onSkipToPrevious() {
        service.skipToPrevious()
    }

    /** Android Auto browse tap (WI-1496 t900 Task 1) -- resolves via
     * [PlayerNotificationService.preparePlaybackFromMediaId], which forwards to the JS bridge;
     * this service never resolves/loads a session itself. */
    override fun onPlayFromMediaId(mediaId: String?, extras: Bundle?) {
        Log.d(tag, "onPlayFromMediaId $mediaId")
        mediaId?.let { service.preparePlaybackFromMediaId(it) }
    }

    /** Android Auto voice search (WI-1496 t900 Task 1). Read-only against already-known/cached
     * items -- never starts acquisition. */
    override fun onPlayFromSearch(query: String?, extras: Bundle?) {
        Log.d(tag, "onPlayFromSearch $query")
        query?.let { service.preparePlaybackFromSearch(it) }
    }

    override fun onCustomAction(action: String?, extras: Bundle?) {
        when (action) {
            CUSTOM_ACTION_JUMP_FORWARD -> service.jumpForward()
            CUSTOM_ACTION_JUMP_BACKWARD -> service.jumpBackward()
            else -> Log.d(tag, "onCustomAction: unhandled action $action")
        }
    }
}
