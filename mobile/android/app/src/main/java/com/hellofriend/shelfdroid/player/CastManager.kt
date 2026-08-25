package com.hellofriend.shelfdroid.player

import android.content.Context
import android.util.Log
import com.google.android.exoplayer2.ext.cast.SessionAvailabilityListener
import com.google.android.gms.cast.framework.CastContext
import com.google.android.gms.cast.framework.CastState

interface CastAvailabilityListener {
    fun onCastSessionAvailable()
    fun onCastSessionUnavailable()
}

/**
 * Chromecast session-lifecycle coordinator (WI-1496 t900 Task 3), adapted from the donor app's
 * `player/CastManager.kt` down to the session-availability plumbing this repo's simpler "one
 * active playback backend at a time" model needs -- no `MediaRouteChooserDialog` "pick a device"
 * UI (that needs an AppCompat Activity theme this app hasn't set up for it, out of this task's
 * scope) and no custom route-scan callback; the platform's own Cast button/dialog (wired by a
 * future UI task) is expected to drive route selection.
 *
 * Deliberately does NOT reimplement ExoPlayer2's `CastPlayer`/`Timeline`/`TrackSelection` SPI
 * (the donor's `player/CastPlayer.kt` (1019 lines) / `CastTimeline.kt` / `CastTimelineTracker.kt`
 * / `CastTrackSelection.kt`) -- this class imports the OFFICIAL
 * `com.google.android.exoplayer:extension-cast` artifact's real `SessionAvailabilityListener`
 * directly (confirming the donor app in fact ships both that artifact AND a same-package local
 * fork of one of its classes, which silently shadows it). This milestone adds the artifact as a
 * direct dependency (see build.gradle) instead of forking it: hand-porting ~1200 lines of
 * ExoPlayer internals with zero device/Cast-receiver access to verify against would be
 * substantially riskier than depending on Google's own maintained implementation. See this
 * task's report GAPS/OPEN for the explicit tradeoff. [CastPlaybackController] (`CastPlayer.kt`)
 * holds this app's own thin adapter around the artifact's `CastPlayer`, not a reimplementation
 * of it; `CastTimeline.kt` holds only a small load descriptor, not a `Timeline` SPI
 * implementation.
 *
 * Never opens a second ABS session: [loadMedia]'s [CastMediaDescriptor] is built by the caller
 * from the SAME stream URL / access token the native player already loaded -- the JS
 * `castHandoff.ts` controller (this task) is the actual position/rate handoff logic; this class
 * only tracks Cast session availability and proxies play/pause/seek/load to the Cast receiver.
 */
class CastManager(private val context: Context, private val listener: CastAvailabilityListener) {
    private val tag = "CastManager"

    private val controller: CastPlaybackController? by lazy {
        castContext()?.let { CastPlaybackController(it) }
    }

    private val sessionAvailabilityListener = object : SessionAvailabilityListener {
        override fun onCastSessionAvailable() {
            Log.d(tag, "onCastSessionAvailable")
            listener.onCastSessionAvailable()
        }

        override fun onCastSessionUnavailable() {
            Log.d(tag, "onCastSessionUnavailable")
            listener.onCastSessionUnavailable()
        }
    }

    fun start() {
        controller?.setSessionAvailabilityListener(sessionAvailabilityListener)
    }

    fun stop() {
        controller?.setSessionAvailabilityListener(null)
    }

    fun isReceiverAvailable(): Boolean = castContext()?.castState != CastState.NO_DEVICES_AVAILABLE

    fun loadMedia(descriptor: CastMediaDescriptor) {
        controller?.loadMedia(descriptor)
    }

    fun play() = controller?.play() ?: Unit
    fun pause() = controller?.pause() ?: Unit
    fun seekTo(positionMs: Long) = controller?.seekTo(positionMs) ?: Unit

    private fun castContext(): CastContext? = try {
        CastContext.getSharedInstance(context)
    } catch (e: Exception) {
        // No Google Play services / Cast framework available on this device -- not fatal, Cast
        // is simply unavailable. Explicit here (unlike the donor, which assumes CastContext
        // always resolves) because this app doesn't otherwise require Play services.
        Log.w(tag, "CastContext unavailable: ${e.message}")
        null
    }
}
