package com.hellofriend.shelfdroid.services

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import com.hellofriend.shelfdroid.models.DownloadItem
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel

/** What the download notification shows: the value the poster coalesces and de-duplicates on. */
data class DownloadNotificationState(val text: String, val progress: Int = 0, val determinate: Boolean = false)

/**
 * Android-owned foreground lifecycle for offline-download transfers that must outlive the
 * WebView and Activity (WI-1496 t800 Task 3), adapted from the donor app's `DownloadService` down
 * to `DownloadServiceHost`'s simpler wiring (no cancel-notification-action UX beyond what this
 * milestone needs -- can be added alongside Task 4's React queue UI without touching this class).
 * Untested on this machine (needs a real `Context`/`Service` lifecycle) -- same class of gap as
 * `PlayerNotificationService` in t700.
 */
class DownloadService : Service() {
    // Every post to the one download notification (id 12) goes through `poster`, shared by all
    // concurrent downloads, so the app stays under Android's ~5 enqueues/second package limit.
    // The scope only ever runs the poster's single trailing-flush coroutine; it is cancelled in
    // onDestroy.
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val poster = CoalescedPoster<DownloadNotificationState>(
        scope = scope,
        minIntervalMs = NOTIFICATION_MIN_INTERVAL_MS,
        now = { SystemClock.elapsedRealtime() },
        post = { state -> notify(state) }
    )

    override fun onCreate() {
        super.onCreate()
        createChannel()
        startForegroundWithType(DownloadNotificationState("Preparing downloads"))
        DownloadServiceHost.attachService(this)
        DownloadServiceHost.ensure(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        poster.reopen()
        // Not throttled: startForeground() must follow every startForegroundService(). Re-showing
        // the last posted state (not a fresh "Downloading") avoids resetting a live progress bar.
        startForegroundWithType(poster.lastPosted ?: DownloadNotificationState("Downloading"))
        DownloadServiceHost.ensure(this)
        return START_STICKY
    }

    override fun onDestroy() {
        DownloadServiceHost.detachService(this)
        // Drop any pending trailing post and refuse new ones before the coroutine scope goes.
        poster.close()
        scope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    /** Progress and wait/pause transitions: coalesced; the newest state is always delivered
     * within one interval. A failed or cancelled item is terminal and bypasses the throttle. */
    fun onItemUpdated(item: DownloadItem) {
        val activePart = item.parts.firstOrNull { it.state == "running" }
        val text = when {
            item.state == "failed" -> "${item.title} failed"
            activePart != null -> "Downloading ${activePart.filename}"
            item.parts.any { it.state == "waiting_for_space" } -> "Waiting for available storage"
            item.parts.any { it.state == "waiting_for_network" } -> "Waiting for Wi-Fi"
            else -> item.title
        }
        val progress = if (item.totalBytes > 0L) ((item.bytesDownloaded * 100L) / item.totalBytes).toInt() else 0
        val state = DownloadNotificationState(text, progress.coerceIn(0, 100), item.totalBytes > 0L)
        if (item.state == "failed" || item.state == "cancelled") poster.postNow(state) else poster.submit(state)
    }

    /** Terminal: always delivered immediately, and discards any older pending progress post. */
    fun onItemComplete(item: DownloadItem) {
        poster.postNow(DownloadNotificationState("${item.title} downloaded", 100, true))
    }

    fun onQueueChanged(hasWork: Boolean) {
        if (!hasWork) {
            // Close first: a pending trailing post (or a late progress callback from another
            // thread) must not re-post the notification after it is removed.
            poster.close()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    private fun startForegroundWithType(state: DownloadNotificationState) {
        val notification = buildNotification(state)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        // startForeground() is an enqueue like any other; count it against the interval.
        poster.noteExternalPost(state)
    }

    private fun notify(state: DownloadNotificationState) {
        (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).notify(NOTIFICATION_ID, buildNotification(state))
    }

    private fun buildNotification(state: DownloadNotificationState): Notification =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle("Downloads")
            .setContentText(state.text)
            .setOnlyAlertOnce(true)
            .setOngoing(true)
            .setProgress(100, state.progress.coerceIn(0, 100), !state.determinate)
            .build()

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Downloads", NotificationManager.IMPORTANCE_LOW))
    }

    companion object {
        private const val CHANNEL_ID = "downloads"
        private const val NOTIFICATION_ID = 12

        /** Minimum gap between non-terminal posts to the download notification. Android sheds
         * enqueues above ~5/s for the whole package (playback notification and startForeground
         * calls share that budget); 1 s keeps downloads at <=1/s however many run, leaving ample
         * headroom, and a once-a-second progress bar still reads as live. */
        private const val NOTIFICATION_MIN_INTERVAL_MS = 1000L
        fun intent(context: android.content.Context) = Intent(context, DownloadService::class.java)
    }
}
