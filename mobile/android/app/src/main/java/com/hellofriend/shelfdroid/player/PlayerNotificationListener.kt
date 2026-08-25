package com.hellofriend.shelfdroid.player

import android.app.Notification
import android.content.pm.ServiceInfo
import android.os.Build
import android.util.Log
import com.google.android.exoplayer2.ui.PlayerNotificationManager

/** Adapted from the donor app's `PlayerNotificationListener.kt`, stripped of the cast-switching
 * (`isSwitchingPlayer`) and widget-update concerns that are out of scope for this milestone. */
class PlayerNotificationListener(private val service: PlayerNotificationService) :
    PlayerNotificationManager.NotificationListener {
    private val tag = "PlayerNotificationListener"

    override fun onNotificationPosted(notificationId: Int, notification: Notification, ongoing: Boolean) {
        if (!ongoing) {
            Log.d(tag, "onNotificationPosted $notificationId not ongoing, not starting foreground")
            return
        }
        Log.d(tag, "onNotificationPosted $notificationId, starting foreground")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            service.startForeground(notificationId, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        } else {
            service.startForeground(notificationId, notification)
        }
    }

    override fun onNotificationCancelled(notificationId: Int, dismissedByUser: Boolean) {
        Log.d(tag, "onNotificationCancelled $notificationId dismissedByUser=$dismissedByUser")
        if (dismissedByUser) service.stopSelf()
    }
}
