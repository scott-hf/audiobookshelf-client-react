package com.hellofriend.shelfdroid.services

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestCoroutineScheduler
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class CoalescedPosterTest {
    private val scheduler = TestCoroutineScheduler()
    private val scope = CoroutineScope(SupervisorJob() + StandardTestDispatcher(scheduler))
    private val posted = mutableListOf<Pair<Long, String>>()
    private var failPosts = false

    private fun poster(intervalMs: Long = 1000L) = CoalescedPoster<String>(
        scope = scope,
        minIntervalMs = intervalMs,
        now = { scheduler.currentTime },
        post = { value ->
            if (failPosts) throw IllegalStateException("boom")
            posted += scheduler.currentTime to value
        }
    )

    private fun advance(ms: Long) {
        scheduler.advanceTimeBy(ms)
        scheduler.runCurrent()
    }

    @After
    fun tearDown() {
        scope.cancel()
    }

    @Test
    fun theFirstPostIsImmediate() {
        val poster = poster()
        poster.submit("a")
        assertEquals(listOf(0L to "a"), posted)
    }

    @Test
    fun aBurstInsideTheWindowCollapsesToTheLatestValueAtTheWindowEnd() {
        val poster = poster()
        poster.submit("a")
        advance(100)
        poster.submit("b")
        poster.submit("c")
        poster.submit("d")
        advance(899)
        assertEquals("nothing is posted before the window ends", listOf(0L to "a"), posted)
        advance(1)
        assertEquals(listOf(0L to "a", 1000L to "d"), posted)
    }

    @Test
    fun sustainedUpdatesFromManySourcesNeverExceedOnePostPerInterval() {
        val poster = poster()
        // Three "downloads" each pushing a new value every 250 ms for 10 s (12 updates/s combined).
        for (step in 0 until 40) {
            for (source in 0 until 3) poster.submit("s$source-$step")
            advance(250)
        }
        advance(2000)
        val times = posted.map { it.first }
        assertTrue("expected a post every ~1 s, got $times", posted.size in 10..12)
        times.zipWithNext().forEach { (a, b) -> assertTrue("posts $a and $b are closer than 1 s", b - a >= 1000L) }
        assertEquals("the very last submitted value is what ends up on screen", "s2-39", posted.last().second)
    }

    @Test
    fun anIdenticalValueIsNotPostedAgain() {
        val poster = poster()
        poster.submit("a")
        advance(1500)
        poster.submit("a")
        advance(5000)
        assertEquals(listOf(0L to "a"), posted)
    }

    @Test
    fun aValueMatchingWhatIsOnScreenCancelsAStalePendingValue() {
        val poster = poster()
        poster.submit("a")
        advance(100)
        poster.submit("b")
        poster.submit("a")
        advance(5000)
        assertEquals(listOf(0L to "a"), posted)
    }

    @Test
    fun aTerminalPostInsideTheWindowIsDeliveredImmediatelyAndNotOverwrittenByOlderProgress() {
        val poster = poster()
        poster.submit("progress-1")
        advance(100)
        poster.submit("progress-2")
        poster.postNow("done")
        assertEquals(listOf(0L to "progress-1", 100L to "done"), posted)
        advance(5000)
        assertEquals("the stale pending progress was discarded", listOf(0L to "progress-1", 100L to "done"), posted)
        assertEquals("done", poster.lastPosted)
    }

    @Test
    fun updatesAfterATerminalPostStillRespectTheWindow() {
        val poster = poster()
        poster.postNow("done")
        advance(10)
        poster.submit("next")
        assertEquals(1, posted.size)
        advance(990)
        assertEquals(listOf(0L to "done", 1000L to "next"), posted)
    }

    @Test
    fun closeDropsThePendingPostAndIgnoresLaterOnes() {
        val poster = poster()
        poster.submit("a")
        advance(100)
        poster.submit("b")
        poster.close()
        advance(5000)
        poster.submit("c")
        poster.postNow("d")
        advance(5000)
        assertEquals(listOf(0L to "a"), posted)
    }

    @Test
    fun reopenResumesPosting() {
        val poster = poster()
        poster.submit("a")
        poster.close()
        poster.reopen()
        advance(1000)
        poster.submit("b")
        assertEquals(listOf(0L to "a", 1000L to "b"), posted)
    }

    @Test
    fun anExternalPostMovesTheWindowAndANewerTrailingValueIsStillDelivered() {
        val poster = poster()
        poster.submit("a")
        advance(500)
        poster.submit("b")
        advance(400) // t=900: trailing is due at 1000
        poster.noteExternalPost("fg") // startForeground at t=900 restarts the window to 1900
        advance(200) // t=1100: trailing must have re-waited rather than posting
        assertEquals(listOf(0L to "a"), posted)
        advance(800)
        assertEquals(listOf(0L to "a", 1900L to "b"), posted)
    }

    @Test
    fun aThrowingPostDoesNotEscapeTheCaller() {
        val poster = poster()
        failPosts = true
        poster.submit("a")
        poster.postNow("b")
        failPosts = false
        advance(1000)
        poster.submit("c")
        assertEquals(listOf(1000L to "c"), posted)
    }
}
