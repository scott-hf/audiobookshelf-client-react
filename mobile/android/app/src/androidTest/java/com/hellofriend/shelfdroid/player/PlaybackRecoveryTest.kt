package com.hellofriend.shelfdroid.player

import android.content.Context
import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.rule.ServiceTestRule
import com.hellofriend.shelfdroid.data.AudioTrack
import com.hellofriend.shelfdroid.data.PlaybackSession
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Instrumented recovery test for WI-1496 t700 Task 4. A [PlaybackStateStore] write made "by an
 * earlier app session" must be visible to a freshly bound [PlayerNotificationService] instance --
 * the on-device analogue of surviving Activity recreation / process death, since the store is the
 * only channel connecting the two service lifetimes (nothing survives in memory across them).
 * Requires a connected device/emulator to run:
 * `./mobile/android/gradlew -p mobile/android connectedDebugAndroidTest
 *   -Pandroid.testInstrumentationRunnerArguments.class=com.hellofriend.shelfdroid.player.PlaybackRecoveryTest`
 */
@RunWith(AndroidJUnit4::class)
class PlaybackRecoveryTest {
    @get:Rule
    val serviceRule = ServiceTestRule()

    @Test
    fun serviceRestoresPausedSessionAfterActivityRecreation() {
        val context = ApplicationProvider.getApplicationContext<Context>()

        // Simulates the session a prior app instance had loaded (equivalent to Task 1's
        // sessionFixture) -- PlaybackStateStore is what has to carry it across the recreation.
        val session = PlaybackSession(
            id = "session-1",
            currentTime = 42.0,
            audioTracks = listOf(AudioTrack(index = 0, contentUrl = "/fake/track.mp3", duration = 3600.0))
        )
        PlaybackStateStore(context).save(
            StoredPlaybackState(
                sessionId = session.id,
                libraryItemId = session.id,
                sessionJson = PlaybackStateStore.sessionToJson(session),
                positionMs = 42_000L,
                rate = 1f,
                shouldResume = false,
                serverUrlFingerprint = "https://fake.example.test",
                updatedAt = System.currentTimeMillis()
            )
        )

        // Bind a fresh PlayerNotificationService instance -- its onCreate() must read the store
        // written above and surface it as a paused, recoverable snapshot before any load() call.
        val binder = serviceRule.bindService(Intent(context, PlayerNotificationService::class.java))
        val service = (binder as PlayerNotificationService.LocalBinder).getService()

        val state = service.getState()
        assertEquals("session-1", service.currentSession?.id)
        assertEquals(42_000L, state.currentTimeMs)
        assertEquals(PlayerStatus.PAUSED, state.status)
    }
}
