package com.hellofriend.shelfdroid

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.util.Log
import android.view.View
import android.widget.RemoteViews
import com.bumptech.glide.Glide
import com.bumptech.glide.request.RequestOptions
import com.bumptech.glide.request.target.AppWidgetTarget
import com.hellofriend.shelfdroid.player.PlayerNotificationService

/** Widget button intent actions, targeted explicitly at [PlayerNotificationService] (never at
 * `MediaButtonReceiver`/`PlaybackStateCompat` like the donor app -- this repo's service already
 * exposes plain `play()`/`pause()`/`jumpForward()`/`jumpBackward()` methods (t700), so the widget
 * calls those directly through an explicit, immutable service `PendingIntent` instead of going
 * through the media-session button indirection). */
const val ACTION_PLAY_PAUSE = "com.hellofriend.shelfdroid.widget.ACTION_PLAY_PAUSE"
const val ACTION_BACK = "com.hellofriend.shelfdroid.widget.ACTION_BACK"
const val ACTION_FORWARD = "com.hellofriend.shelfdroid.widget.ACTION_FORWARD"

/** The existing command vocabulary this widget's buttons map onto -- [PlayerNotificationService]
 * already implements each one (`play`/`pause` toggle, `jumpBackward`, `jumpForward`); this enum
 * exists only so [MediaPlayerWidget.commandFor] is a pure, JVM-testable mapping from a widget
 * intent action to "which existing service method to call", without inventing a new command
 * channel. */
enum class PlayerCommand { PLAY_PAUSE, JUMP_BACK, JUMP_FORWARD }

/**
 * Read-only home-screen player widget (WI-1496 t900 Task 2): cover, title, author, play/pause,
 * jump back, jump forward. Adapted from the donor app's root-level `MediaPlayerWidget.kt`, which
 * reads a full `PlaybackSession`/`LibraryItemWrapper` (`displayTitle`/`displayAuthor`/
 * `getCoverUri`) off `DeviceManager.deviceData.lastPlaybackSession`. This repo's native
 * `PlaybackSession` (t700) is deliberately minimal (id/currentTime/audioTracks only, no
 * title/author/cover) and there is no `DeviceManager` -- so this widget renders generic
 * "Audiobook" placeholder text plus a play/pause glyph reflecting [PlayerNotificationService]'s
 * live [com.hellofriend.shelfdroid.player.PlayerSnapshot] until a metadata bridge exists (see
 * this task's GAPS note); it never invents a fake title. Buttons send explicit, immutable
 * (`FLAG_IMMUTABLE`, required on Android 12+) `PendingIntent`s that start
 * [PlayerNotificationService] with one of [ACTION_PLAY_PAUSE]/[ACTION_BACK]/[ACTION_FORWARD].
 */
class MediaPlayerWidget : AppWidgetProvider() {
    private val tag = "MediaPlayerWidget"

    override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
        Log.d(tag, "onUpdate ${appWidgetIds.toList()}")
        appWidgetIds.forEach { updateAppWidget(context, appWidgetManager, it, isPlaying = false, hasSession = false) }
    }

    companion object {
        /** Pure mapping from a widget button's intent action to the existing service command it
         * targets -- no Android types involved, so this is directly JVM-unit-testable. */
        fun commandFor(action: String?): PlayerCommand? = when (action) {
            ACTION_PLAY_PAUSE -> PlayerCommand.PLAY_PAUSE
            ACTION_BACK -> PlayerCommand.JUMP_BACK
            ACTION_FORWARD -> PlayerCommand.JUMP_FORWARD
            else -> null
        }

        private fun servicePendingIntent(context: Context, action: String): PendingIntent {
            val intent = Intent(context, PlayerNotificationService::class.java).setAction(action)
            return PendingIntent.getService(
                context,
                action.hashCode(),
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }

        /** Called by [MediaPlayerWidget.onUpdate] and by [PlayerNotificationService] itself after
         * every state/metadata change (see that class's `notifyWidgets`). */
        fun updateAppWidget(
            context: Context,
            appWidgetManager: AppWidgetManager,
            appWidgetId: Int,
            isPlaying: Boolean,
            hasSession: Boolean,
            title: String = "Not Playing",
            author: String = ""
        ) {
            val views = RemoteViews(context.packageName, R.layout.media_player_widget)

            val openAppIntent = Intent(context, MainActivity::class.java)
                .setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_NEW_TASK)
            val openAppPendingIntent = PendingIntent.getActivity(
                context,
                0,
                openAppIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            views.setOnClickPendingIntent(R.id.widgetBackground, openAppPendingIntent)

            views.setOnClickPendingIntent(R.id.widgetPlayPauseButton, servicePendingIntent(context, ACTION_PLAY_PAUSE))
            views.setOnClickPendingIntent(R.id.widgetRewindButton, servicePendingIntent(context, ACTION_BACK))
            views.setOnClickPendingIntent(R.id.widgetFastForwardButton, servicePendingIntent(context, ACTION_FORWARD))

            views.setViewVisibility(R.id.widgetButtonContainer, if (hasSession) View.VISIBLE else View.GONE)
            views.setTextViewText(R.id.widgetMediaTitle, title)
            views.setTextViewText(R.id.widgetArtistText, author)

            val playPauseResource = if (isPlaying) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play
            views.setImageViewResource(R.id.widgetPlayPauseButton, playPauseResource)

            // WI-1496 t900 Task 2 GAPS note: no per-book cover URI is available from this repo's
            // minimal PlaybackSession (see class doc) -- placeholder-only until a metadata bridge
            // exists. Glide is still wired here (matching the donor's AppWidgetTarget pattern) so
            // swapping in a real cover URI later is a one-line change, not a new dependency.
            val target = object : AppWidgetTarget(context.applicationContext, R.id.widgetAlbumArt, views, appWidgetId) {}
            Glide.with(context.applicationContext).asBitmap()
                .load(R.mipmap.ic_launcher)
                .apply(RequestOptions().override(200, 200))
                .into(target)

            appWidgetManager.updateAppWidget(appWidgetId, views)
        }

        fun widgetIds(context: Context): IntArray {
            val manager = AppWidgetManager.getInstance(context)
            return manager.getAppWidgetIds(ComponentName(context, MediaPlayerWidget::class.java))
        }
    }
}
