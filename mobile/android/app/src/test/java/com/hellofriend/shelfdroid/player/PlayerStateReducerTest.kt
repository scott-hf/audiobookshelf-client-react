package com.hellofriend.shelfdroid.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PlayerStateReducerTest {
    @Test
    fun endedStateStopsForegroundAndEmitsFinalPosition() {
        val reducer = PlayerStateReducer()
        val result = reducer.reduce(PlayerEvent.Ended(positionMs = 3_600_000))
        assertEquals(PlayerStatus.ENDED, result.snapshot.status)
        assertTrue(result.stopForeground)
        assertTrue(result.syncFinalProgress)
    }

    @Test
    fun playingStateDoesNotStopForegroundOrSync() {
        val reducer = PlayerStateReducer()
        val result = reducer.reduce(PlayerEvent.Playing(positionMs = 42_000, durationMs = 3_600_000, rate = 1.25f))
        assertEquals(PlayerStatus.PLAYING, result.snapshot.status)
        assertEquals(42_000L, result.snapshot.currentTimeMs)
        assertEquals(1.25f, result.snapshot.rate)
        assertFalse(result.stopForeground)
        assertFalse(result.syncFinalProgress)
    }

    @Test
    fun pausedStateRequestsFinalSyncButNotForegroundStop() {
        val reducer = PlayerStateReducer()
        val result = reducer.reduce(PlayerEvent.Paused(positionMs = 1_000, durationMs = 10_000, rate = 1f))
        assertEquals(PlayerStatus.PAUSED, result.snapshot.status)
        assertFalse(result.stopForeground)
        assertTrue(result.syncFinalProgress)
    }

    @Test
    fun positionClampsIntoZeroToDurationRange() {
        val reducer = PlayerStateReducer()
        val over = reducer.reduce(PlayerEvent.Playing(positionMs = 999_999, durationMs = 10_000, rate = 1f))
        assertEquals(10_000L, over.snapshot.currentTimeMs)

        val under = reducer.reduce(PlayerEvent.Buffering(positionMs = -5, durationMs = 10_000, rate = 1f))
        assertEquals(0L, under.snapshot.currentTimeMs)
    }

    @Test
    fun errorStateStopsForegroundAndCarriesMessage() {
        val reducer = PlayerStateReducer()
        val result = reducer.reduce(PlayerEvent.Error("device offline"))
        assertEquals(PlayerStatus.ERROR, result.snapshot.status)
        assertTrue(result.stopForeground)
        assertFalse(result.syncFinalProgress)
        assertEquals("device offline", result.snapshot.error)
    }

    @Test
    fun nonErrorStatesCarryNoErrorMessage() {
        val reducer = PlayerStateReducer()
        val result = reducer.reduce(PlayerEvent.Playing(positionMs = 0, durationMs = 1_000, rate = 1f))
        assertNull(result.snapshot.error)
    }
}
