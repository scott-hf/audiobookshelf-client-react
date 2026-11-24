package com.hellofriend.shelfdroid.player

import com.hellofriend.shelfdroid.data.AudioTrack
import com.hellofriend.shelfdroid.data.PlaybackSession
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The final-position-on-task-removal path (`PlayerNotificationService.onTaskRemoved`) and the live
 * persistence it shares its decisions with, exercised on the JVM through [PlaybackRecovery] and a
 * fake [PlaybackStorage]. */
class PlaybackRecoveryTest {
    private val session = PlaybackSession(
        id = "session-1",
        currentTime = 12.5,
        audioTracks = listOf(AudioTrack(index = 0, contentUrl = "/api/items/b1/file/f1", duration = 3600.0))
    )

    private fun snapshot(status: PlayerStatus, positionMs: Long = 42_000, rate: Float = 1.25f) =
        PlayerSnapshot(status, positionMs, 3_600_000, rate, playWhenReady = status == PlayerStatus.PLAYING)

    /** In-memory [PlaybackStorage] recording which write path was used. */
    private class FakeStorage : PlaybackStorage {
        var value: String? = null
        var plainWrites = 0
        var durableWrites = 0

        override fun read(): String? = value

        override fun write(value: String) {
            plainWrites++
            this.value = value
        }

        override fun writeDurably(value: String) {
            durableWrites++
            this.value = value
        }

        override fun clear() {
            value = null
        }
    }

    @Test
    fun taskRemovalSavesTheLivePositionNotTheStaleSnapshotOne() {
        // The last snapshot is up to a tick (500 ms) or the 5 s persist throttle behind the player.
        val state = PlaybackRecovery.taskRemovedState(snapshot(PlayerStatus.PLAYING, positionMs = 42_000), session, livePositionMs = 47_300, serverUrl = "https://books.test", nowMs = 1_000)
        assertNotNull(state)
        assertEquals(47_300L, state!!.positionMs)
        assertEquals("session-1", state.sessionId)
        assertEquals("https://books.test", state.serverUrlFingerprint)
        assertEquals(1.25f, state.rate)
        assertEquals(1_000L, state.updatedAt)
    }

    @Test
    fun taskRemovalNeverMarksTheSessionAsShouldResume() {
        // Playback is being stopped, so the next cold start must show the position, not auto-play.
        for (status in listOf(PlayerStatus.PLAYING, PlayerStatus.BUFFERING, PlayerStatus.PAUSED)) {
            val state = PlaybackRecovery.taskRemovedState(snapshot(status), session, 1_000, "s", 0)
            assertNotNull("$status should be recoverable", state)
            assertFalse("$status must not resume", state!!.shouldResume)
        }
    }

    @Test
    fun taskRemovalDoesNotResurrectFinishedFailedOrEmptySessions() {
        // ENDED/ERROR/IDLE already cleared the store on purpose; a swipe from recents must not undo that.
        for (status in listOf(PlayerStatus.ENDED, PlayerStatus.ERROR, PlayerStatus.IDLE, PlayerStatus.LOADING)) {
            assertNull("$status", PlaybackRecovery.taskRemovedState(snapshot(status), session, 1_000, "s", 0))
        }
        // No session loaded: nothing to describe.
        assertNull(PlaybackRecovery.taskRemovedState(snapshot(PlayerStatus.PLAYING), null, 1_000, "s", 0))
    }

    @Test
    fun taskRemovalClampsANegativeLivePosition() {
        val state = PlaybackRecovery.taskRemovedState(snapshot(PlayerStatus.PAUSED), session, livePositionMs = -5, serverUrl = "s", nowMs = 0)
        assertEquals(0L, state!!.positionMs)
    }

    @Test
    fun liveStateMirrorsThePlayingIntentAndSkipsNonRecoverableStatuses() {
        assertTrue(PlaybackRecovery.liveState(snapshot(PlayerStatus.PLAYING), session, "s", 0)!!.shouldResume)
        assertFalse(PlaybackRecovery.liveState(snapshot(PlayerStatus.PAUSED), session, "s", 0)!!.shouldResume)
        assertFalse(PlaybackRecovery.liveState(snapshot(PlayerStatus.BUFFERING), session, "s", 0)!!.shouldResume)
        for (status in listOf(PlayerStatus.ENDED, PlayerStatus.ERROR, PlayerStatus.IDLE, PlayerStatus.LOADING)) {
            assertNull("$status", PlaybackRecovery.liveState(snapshot(status), session, "s", 0))
        }
        assertNull(PlaybackRecovery.liveState(snapshot(PlayerStatus.PLAYING), null, "s", 0))
    }

    @Test
    fun finalStateIsWrittenDurablyAndRecoverableByTheNextColdStart() {
        val storage = FakeStorage()
        val store = PlaybackStateStore(storage)
        // A periodic write earlier in the session, then the user swipes the app away.
        store.save(PlaybackRecovery.liveState(snapshot(PlayerStatus.PLAYING, positionMs = 30_000), session, "https://books.test", 1)!!)
        assertEquals(1, storage.plainWrites)

        store.saveDurably(PlaybackRecovery.taskRemovedState(snapshot(PlayerStatus.PLAYING, positionMs = 30_000), session, 33_250, "https://books.test", 2)!!)

        assertEquals("the final write must take the durable path", 1, storage.durableWrites)
        // What `restoreRecoveryState` reads back on the next cold start.
        val recovered = store.load()
        assertNotNull(recovered)
        assertEquals(33_250L, recovered!!.positionMs)
        assertFalse(recovered.shouldResume)
        assertEquals("https://books.test", recovered.serverUrlFingerprint)
        val restored = PlaybackStateStore.sessionFromJson(recovered.sessionJson)
        assertEquals("session-1", restored.id)
        assertEquals(1, restored.audioTracks.size)
    }

    @Test
    fun theStoredRecoveryJsonNeverCarriesAnAccessToken() {
        val storage = FakeStorage()
        val store = PlaybackStateStore(storage)
        store.saveDurably(PlaybackRecovery.taskRemovedState(snapshot(PlayerStatus.PLAYING), session, 1_000, "https://books.test", 0)!!)
        val raw = storage.value!!.lowercase()
        assertFalse(raw.contains("token"))
        assertFalse(raw.contains("authorization"))
    }
}
