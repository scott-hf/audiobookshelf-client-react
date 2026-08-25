package com.hellofriend.shelfdroid.managers

import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private class FakeClock(var timeMs: Long = 0) : Clock {
    override fun nowMs(): Long = timeMs
}

class SleepTimerManagerTest {
    @Test
    fun timerPausesAtDeadlineAndCanBeExtended() {
        val clock = FakeClock()
        val manager = SleepTimerManager(clock)

        manager.start(600)
        clock.timeMs += 300_000
        assertFalse(manager.isExpired())

        manager.addSeconds(300)
        clock.timeMs += 599_000
        assertFalse(manager.isExpired())

        clock.timeMs += 1_000
        assertTrue(manager.isExpired())
    }

    @Test
    fun cancelClearsTheDeadline() {
        val clock = FakeClock()
        val manager = SleepTimerManager(clock)
        manager.start(60)
        manager.cancel()
        assertFalse(manager.isRunning)
        assertNull(manager.remainingSeconds())
    }

    @Test
    fun aFreshManagerIsNotExpiredAndNotRunning() {
        val manager = SleepTimerManager(FakeClock())
        assertFalse(manager.isRunning)
        assertFalse(manager.isExpired())
    }
}
