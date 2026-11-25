package com.hellofriend.shelfdroid.services

import java.util.logging.Level
import java.util.logging.Logger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Rate-limits a stream of "latest value wins" posts (the download notification) to at most one
 * post per [minIntervalMs], without ever losing the final value.
 *
 * Android sheds notification posts once a package exceeds roughly 5 enqueues per second
 * (`NotificationService: Package enqueue rate ... Shedding`); a shed post is simply gone, so a
 * throttle that drops the last update inside its window leaves the notification stale. This one
 * never drops: a [submit] inside the window is held as the single pending value and delivered by
 * one trailing coroutine when the window ends, replaced (not queued) by any newer value.
 *
 *  - [submit]: leading-edge post when the window is open (so the first post is never delayed),
 *    otherwise coalesced into the trailing post. A value equal to the last posted one is skipped.
 *  - [postNow]: for terminal states. Always posts immediately, ignoring the window, and discards
 *    any older pending value so it cannot overwrite the terminal one afterwards.
 *  - [noteExternalPost]: records a post made outside this class (the `startForeground` calls, which
 *    also count against the platform limit) so the window is measured from it.
 *  - [close]: drops the pending value and cancels the trailing coroutine; later [submit]/[postNow]
 *    calls are ignored until [reopen]. Called when the queue empties and when the service dies, so
 *    nothing can re-post a notification after `stopForeground(REMOVE)`.
 *
 * One instance is shared by every concurrent download, so the limit is global to the notification
 * rather than per item. All state is guarded by [lock]; [post] is invoked under it, which also
 * serialises posts from the caller threads and the trailing coroutine (post order == decision
 * order). Scheduling uses coroutines on the supplied [scope], matching the rest of the download
 * stack; [now] must be monotonic.
 */
class CoalescedPoster<T : Any>(
    private val scope: CoroutineScope,
    private val minIntervalMs: Long,
    private val now: () -> Long,
    private val post: (T) -> Unit
) {
    private val lock = Any()
    private var hasPosted = false
    private var lastPostAt = 0L
    private var last: T? = null
    private var pending: T? = null
    private var trailing: Job? = null
    private var closed = false

    /** The most recent value actually handed to [post] (or recorded by [noteExternalPost]). */
    val lastPosted: T? get() = synchronized(lock) { last }

    fun submit(value: T) {
        synchronized(lock) {
            if (closed) return
            if (hasPosted && value == last) {
                // The newest value is what is already on screen; nothing left to deliver, and an
                // older pending value must not overwrite it later.
                cancelTrailingLocked()
                return
            }
            if (!hasPosted || now() - lastPostAt >= minIntervalMs) {
                // Window open: post on the leading edge. Any trailing is now moot.
                cancelTrailingLocked()
                postLocked(value)
                return
            }
            pending = value
            if (trailing == null) scheduleTrailingLocked()
        }
    }

    /** Terminal state: delivered immediately, whatever the window says. */
    fun postNow(value: T) {
        synchronized(lock) {
            if (closed) return
            cancelTrailingLocked()
            postLocked(value)
        }
    }

    fun noteExternalPost(value: T) {
        synchronized(lock) {
            hasPosted = true
            lastPostAt = now()
            last = value
        }
    }

    fun close() {
        synchronized(lock) {
            closed = true
            cancelTrailingLocked()
        }
    }

    fun reopen() {
        synchronized(lock) { closed = false }
    }

    private fun cancelTrailingLocked() {
        pending = null
        trailing?.cancel()
        trailing = null
    }

    private fun postLocked(value: T) {
        hasPosted = true
        lastPostAt = now()
        last = value
        try {
            post(value)
        } catch (e: Exception) {
            // Runs on caller threads and the trailing coroutine alike; a failed post (e.g. the
            // notification permission being revoked) must not take the process down.
            LOG.log(Level.WARNING, "Could not post notification", e)
        }
    }

    private fun scheduleTrailingLocked() {
        val job = scope.launch(start = CoroutineStart.LAZY) {
            val self = currentCoroutineContext()[Job]
            while (true) {
                val waitMs = flushOrRemainingMs(self)
                if (waitMs <= 0L) return@launch
                delay(waitMs)
            }
        }
        trailing = job
        job.start()
    }

    /** Posts the pending value if the window has closed (returns 0), else returns the time still
     * to wait. Re-measured after every delay because [noteExternalPost] can move the window. */
    private fun flushOrRemainingMs(self: Job?): Long = synchronized(lock) {
        if (closed || trailing !== self) return@synchronized 0L
        val remaining = minIntervalMs - (now() - lastPostAt)
        if (remaining > 0L) return@synchronized remaining
        trailing = null
        val value = pending
        pending = null
        if (value != null) postLocked(value)
        0L
    }

    private companion object {
        val LOG: Logger = Logger.getLogger("CoalescedPoster")
    }
}
