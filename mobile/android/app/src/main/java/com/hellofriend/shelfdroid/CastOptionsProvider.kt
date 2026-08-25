package com.hellofriend.shelfdroid

import android.content.Context
import com.google.android.gms.cast.framework.CastOptions
import com.google.android.gms.cast.framework.OptionsProvider
import com.google.android.gms.cast.framework.SessionProvider
import com.google.android.gms.cast.framework.media.CastMediaOptions

/**
 * Registers ShelfDroid as a Cast sender (WI-1496 t900 Task 3). Direct port of the donor app's
 * root-level `CastOptionsProvider.kt` (package name adapted only) -- disables the Cast SDK's own
 * media-session/notification management since [com.hellofriend.shelfdroid.player.PlayerNotificationService]
 * (t700) already owns both for native playback; the JS-side `castHandoff.ts` controller (this
 * task) is what actually drives handoff, not the SDK's built-in media-session bridge.
 */
class CastOptionsProvider : OptionsProvider {
    override fun getCastOptions(context: Context): CastOptions =
        CastOptions.Builder()
            .setReceiverApplicationId(DEFAULT_RECEIVER_APP_ID)
            .setCastMediaOptions(
                CastMediaOptions.Builder()
                    .setMediaSessionEnabled(false)
                    .setNotificationOptions(null)
                    .build()
            )
            .setStopReceiverApplicationWhenEndingSession(true)
            .build()

    override fun getAdditionalSessionProviders(context: Context): List<SessionProvider>? = null

    private companion object {
        // Same receiver app id the donor app registers (the default media receiver family) --
        // no ShelfDroid-branded Cast receiver exists yet.
        const val DEFAULT_RECEIVER_APP_ID = "FD1F76C5"
    }
}
