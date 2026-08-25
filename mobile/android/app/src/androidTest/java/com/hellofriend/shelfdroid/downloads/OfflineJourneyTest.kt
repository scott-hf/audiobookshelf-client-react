package com.hellofriend.shelfdroid.downloads

import android.content.Context
import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.rule.ServiceTestRule
import com.hellofriend.shelfdroid.data.AudioTrack
import com.hellofriend.shelfdroid.data.PlaybackSession
import com.hellofriend.shelfdroid.player.PlayerNotificationService
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Instrumented offline-playback journey test for WI-1496 t800 Task 5, mirroring
 * `player/PlaybackRecoveryTest.kt`'s shape (bind a fresh service, call the same real methods the
 * plugin bridge calls, poll `getState()`). `resolveTrackUrl`'s `file://`/`content://` scheme
 * check is `private` and never mutates `currentSession` either way -- the only externally
 * observable effect of the fix is whether ExoPlayer's real `DefaultDataSource.Factory` actually
 * *opens* the local file, which only shows up once `player.prepare()`'s async work reaches
 * `STATE_READY`/`STATE_ENDED` (this test's silent 16-byte file has no valid audio frames, so it
 * reaches `STATE_ENDED` almost immediately rather than truly decoding). Before this task's fix,
 * `resolveTrackUrl` would have passed `"https://fake.example.test" + "file:///data/.../track.mp3"`
 * to ExoPlayer, which fails as an unresolvable HTTP host -- so reaching a non-error state here is
 * the regression guard; reaching `STATE_ERROR` would mean the mangling bug is back (or a new
 * open failure).
 *
 * Requires a connected device/emulator to run:
 * `./mobile/android/gradlew -p mobile/android connectedDebugAndroidTest
 *   -Pandroid.testInstrumentationRunnerArguments.class=com.hellofriend.shelfdroid.downloads.OfflineJourneyTest`
 *
 * Device-level claims this test does NOT cover (no emulator/device available this session, per
 * every prior t700/t800 native task -- see the dispatch report's GAPS): a download interrupted by
 * process death resumes; completed content plays in airplane mode with real decoded audio output;
 * deleting a local item stops playback cleanly and removes catalog+files.
 */
@RunWith(AndroidJUnit4::class)
class OfflineJourneyTest {
    @get:Rule
    val serviceRule = ServiceTestRule()

    @Test
    fun opensALocalFileUriTrackInsteadOfTreatingItAsAServerRelativeUrl() {
        val context = ApplicationProvider.getApplicationContext<Context>()

        // A real on-disk file under the app's own storage -- mirrors where the native downloader
        // (DownloadItemManager.kt) writes a completed track's finalDestinationPath, and where
        // offlineSource.ts's toLocalUri points a file:// URI at.
        val trackFile = File(context.filesDir, "offline-journey-test-track.mp3")
        trackFile.writeBytes(ByteArray(16))
        val trackUri = "file://${trackFile.absolutePath}"

        val binder = serviceRule.bindService(Intent(context, PlayerNotificationService::class.java))
        val service = (binder as PlayerNotificationService.LocalBinder).getService()

        val session = PlaybackSession(
            id = "book-1",
            currentTime = 0.0,
            audioTracks = listOf(AudioTrack(index = 0, contentUrl = trackUri, duration = 0.0))
        )
        // Deliberately blank accessToken and an unreachable serverUrl -- matches
        // PlayerProvider.tsx's offline path, which plays without a synced ABS session, and proves
        // the mangling bug (prefixing serverUrl onto a local URI) is not what's being exercised.
        service.load(session, accessToken = "", serverUrl = "https://should-not-be-prefixed.invalid")

        // Wait for ExoPlayer to settle out of the transient LOADING/BUFFERING states this
        // silent-content fixture passes through -- either PAUSED (source opened, ready to play,
        // playWhenReady=false since play() was never called) or ENDED (the 16 zero bytes have no
        // frames to play) both prove the file:// URI opened; ERROR is the regression this fix
        // targets (a mangled "https://...file://..." URL that ExoPlayer cannot resolve).
        val settled = pollUntil(timeoutMs = 5_000) {
            val status = service.getState().status
            status != com.hellofriend.shelfdroid.player.PlayerStatus.LOADING && status != com.hellofriend.shelfdroid.player.PlayerStatus.BUFFERING
        }
        assertTrue("expected ExoPlayer to settle out of LOADING/BUFFERING", settled)
        assertTrue(
            "expected ExoPlayer to open the local file:// track instead of erroring on a mangled URL, got ${service.getState().status}",
            service.getState().status != com.hellofriend.shelfdroid.player.PlayerStatus.ERROR
        )

        trackFile.delete()
    }

    private fun pollUntil(timeoutMs: Long, intervalMs: Long = 100, condition: () -> Boolean): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (condition()) return true
            Thread.sleep(intervalMs)
        }
        return condition()
    }
}
