package com.hellofriend.shelfdroid.managers

/** Clock seam for deterministic JVM unit testing (mirrors PlayerStateReducer's separation of a
 * pure/testable core from its Android-facing shell). */
interface Clock {
    fun nowMs(): Long
}

class SystemClock : Clock {
    override fun nowMs(): Long = System.currentTimeMillis()
}

/**
 * Adapted from the donor app's `SleepTimerManager`: tracks a fixed deadline and supports
 * extending the remaining time. This milestone strips chapter-relative timers, shake-to-reset,
 * and volume fade-out (out of scope for Task 3 -- a fixed deadline timer is all the plan asks
 * for); [com.hellofriend.shelfdroid.player.PlayerNotificationService] polls [isExpired] and
 * pauses playback when it flips true.
 */
class SleepTimerManager(private val clock: Clock = SystemClock()) {
    private var deadlineMs: Long? = null

    val isRunning: Boolean
        get() = deadlineMs != null

    fun start(seconds: Long) {
        deadlineMs = clock.nowMs() + seconds * 1000
    }

    /** Extends the current deadline (or starts one from now if none is running). */
    fun addSeconds(seconds: Long) {
        val base = deadlineMs ?: clock.nowMs()
        deadlineMs = base + seconds * 1000
    }

    fun cancel() {
        deadlineMs = null
    }

    fun remainingSeconds(): Long? {
        val deadline = deadlineMs ?: return null
        return maxOf(0, (deadline - clock.nowMs()) / 1000)
    }

    fun isExpired(): Boolean {
        val deadline = deadlineMs ?: return false
        return clock.nowMs() >= deadline
    }
}
