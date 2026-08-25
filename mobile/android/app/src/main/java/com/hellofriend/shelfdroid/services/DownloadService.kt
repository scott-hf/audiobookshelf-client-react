package com.hellofriend.shelfdroid.services

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.hellofriend.shelfdroid.models.DownloadItem

/**
 * Android-owned foreground lifecycle for offline-download transfers that must outlive the
 * WebView and Activity (WI-1496 t800 Task 3), adapted from the donor app's `DownloadService` down
 * to `DownloadServiceHost`'s simpler wiring (no cancel-notification-action UX beyond what this
 * milestone needs -- can be added alongside Task 4's React queue UI without touching this class).
 * Untested on this machine (needs a real `Context`/`Service` lifecycle) -- same class of gap as
 * `PlayerNotificationService` in t700.
 */
class DownloadService : Service() {
    override fun onCreate() {
        super.onCreate()
        createChannel()
        startForegroundWithType("Preparing downloads")
        DownloadServiceHost.attachService(this)
        DownloadServiceHost.ensure(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForegroundWithType("Downloading")
        DownloadServiceHost.ensure(this)
        return START_STICKY
    }

    override fun onDestroy() {
        DownloadServiceHost.detachService(this)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    fun onItemUpdated(item: DownloadItem) {
        val activePart = item.parts.firstOrNull { it.state == "running" }
        val text = when {
            activePart != null -> "Downloading ${activePart.filename}"
            item.parts.any { it.state == "waiting_for_space" } -> "Waiting for available storage"
            item.parts.any { it.state == "waiting_for_network" } -> "Waiting for Wi-Fi"
            else -> item.title
        }
        val progress = if (item.totalBytes > 0L) ((item.bytesDownloaded * 100L) / item.totalBytes).toInt() else 0
        notify(text, progress, item.totalBytes > 0L)
    }

    fun onItemComplete(item: DownloadItem) {
        notify("${item.title} downloaded", 100, true)
    }

    fun onQueueChanged(hasWork: Boolean) {
        if (!hasWork) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    private fun startForegroundWithType(text: String) {
        val notification = buildNotification(text)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun notify(text: String, progress: Int, determinate: Boolean) {
        (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).notify(NOTIFICATION_ID, buildNotification(text, progress, determinate))
    }

    private fun buildNotification(text: String, progress: Int = 0, determinate: Boolean = false): Notification =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle("Downloads")
            .setContentText(text)
            .setOnlyAlertOnce(true)
            .setOngoing(true)
            .setProgress(100, progress.coerceIn(0, 100), !determinate)
            .build()

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Downloads", NotificationManager.IMPORTANCE_LOW))
    }

    companion object {
        private const val CHANNEL_ID = "downloads"
        private const val NOTIFICATION_ID = 12
        fun intent(context: android.content.Context) = Intent(context, DownloadService::class.java)
    }
}
