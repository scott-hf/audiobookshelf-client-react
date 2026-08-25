package com.hellofriend.shelfdroid.player

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Binder
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.media.session.MediaButtonReceiver
import com.hellofriend.shelfdroid.managers.SleepTimerManager
import com.google.android.exoplayer2.C
import com.google.android.exoplayer2.ExoPlayer
import com.google.android.exoplayer2.MediaItem
import com.google.android.exoplayer2.PlaybackParameters
import com.google.android.exoplayer2.audio.AudioAttributes
import com.google.android.exoplayer2.source.ConcatenatingMediaSource
import com.google.android.exoplayer2.source.MediaSource
import com.google.android.exoplayer2.source.ProgressiveMediaSource
import com.google.android.exoplayer2.ui.PlayerNotificationManager
import com.google.android.exoplayer2.upstream.DefaultHttpDataSource
import com.hellofriend.shelfdroid.data.PlaybackSession

/**
 * Foreground service owning the ExoPlayer instance, MediaSessionCompat, and playback
 * notification. Adapted (not ported verbatim) from the donor app's 2200-line
 * `PlayerNotificationService.kt`: this milestone strips database/downloader/cast/widget/
 * browse-tree/Android-Auto and MediaSessionConnector-driven queue navigation entirely, wiring
 * the media session's playback state and callback manually instead. Accepts exactly one
 * already-resolved [PlaybackSession] per `load()` call (from the Task 1 TS contract), never
 * resolves one itself.
 */
class PlayerNotificationService : Service() {
    private val tag = "PlayerNotificationService"
    private val binder = LocalBinder()

    /** Bridge to the Capacitor plugin: forwards each translated snapshot to the JS side, which
     * owns ABS progress-sync duties (per the Task 1 contract note) -- this service only signals
     * the need via [ReducerResult.syncFinalProgress], never syncs to the ABS server itself. */
    interface PlaybackStateEmitter {
        fun onPlayerState(snapshot: PlayerSnapshot)
    }

    var stateEmitter: PlaybackStateEmitter? = null

    lateinit var player: ExoPlayer
        private set
    private lateinit var mediaSession: MediaSessionCompat
    private lateinit var playerNotificationManager: PlayerNotificationManager

    var currentSession: PlaybackSession? = null
        private set
    private var accessToken: String = ""
    private var serverUrl: String = ""

    private var lastSnapshot = PlayerSnapshot(PlayerStatus.IDLE, 0, 0, 1f)

    private val sleepTimerManager = SleepTimerManager()
    private val sleepCheckHandler = Handler(Looper.getMainLooper())
    private val sleepCheckRunnable = object : Runnable {
        override fun run() {
            if (sleepTimerManager.isRunning && sleepTimerManager.isExpired()) {
                Log.d(tag, "Sleep timer expired, pausing")
                pause()
                sleepTimerManager.cancel()
                return
            }
            if (sleepTimerManager.isRunning) {
                sleepCheckHandler.postDelayed(this, 1_000)
            }
        }
    }

    inner class LocalBinder : Binder() {
        fun getService(): PlayerNotificationService = this@PlayerNotificationService
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onCreate() {
        super.onCreate()

        mediaSession = MediaSessionCompat(this, tag).apply {
            val sessionActivityPendingIntent = packageManager?.getLaunchIntentForPackage(packageName)?.let {
                PendingIntent.getActivity(this@PlayerNotificationService, 0, it, PendingIntent.FLAG_IMMUTABLE)
            }
            setSessionActivity(sessionActivityPendingIntent)
            setCallback(MediaSessionCallback(this@PlayerNotificationService))
            setMediaButtonReceiver(
                PendingIntent.getBroadcast(
                    this@PlayerNotificationService,
                    0,
                    Intent(Intent.ACTION_MEDIA_BUTTON).setClass(this@PlayerNotificationService, MediaButtonReceiver::class.java),
                    PendingIntent.FLAG_IMMUTABLE
                )
            )
            isActive = true
        }

        val resolvedChannelId = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            createNotificationChannel()
        } else {
            NOTIFICATION_CHANNEL_ID
        }

        val builder = PlayerNotificationManager.Builder(this, NOTIFICATION_ID, resolvedChannelId)
        builder.setNotificationListener(PlayerNotificationListener(this))
        playerNotificationManager = builder.build()
        playerNotificationManager.setMediaSessionToken(mediaSession.sessionToken)
        playerNotificationManager.setUsePlayPauseActions(true)
        playerNotificationManager.setUseNextAction(false)
        playerNotificationManager.setUsePreviousAction(false)
        playerNotificationManager.setUseChronometer(false)
        playerNotificationManager.setUseStopAction(false)
        playerNotificationManager.setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
        playerNotificationManager.setPriority(NotificationCompat.PRIORITY_LOW)

        initializePlayer()
    }

    private fun createNotificationChannel(): String {
        val channel = NotificationChannel(
            NOTIFICATION_CHANNEL_ID,
            NOTIFICATION_CHANNEL_NAME,
            NotificationManager.IMPORTANCE_LOW
        )
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(channel)
        return NOTIFICATION_CHANNEL_ID
    }

    private fun initializePlayer() {
        player = ExoPlayer.Builder(this).build()
        player.setHandleAudioBecomingNoisy(true)
        player.addListener(PlayerListener(this))
        val audioAttributes = AudioAttributes.Builder()
            .setUsage(C.USAGE_MEDIA)
            .setContentType(C.AUDIO_CONTENT_TYPE_SPEECH)
            .build()
        player.setAudioAttributes(audioAttributes, true)
        playerNotificationManager.setPlayer(player)
    }

    /*
      User-callable methods -- called by plugins/AbsAudioPlayer.kt.
     */

    fun load(session: PlaybackSession, accessToken: String, serverUrl: String) {
        if (session.audioTracks.isEmpty()) {
            Log.e(tag, "load: session ${session.id} has no audio tracks")
            applyReducerResult(
                ReducerResult(
                    PlayerSnapshot(PlayerStatus.ERROR, 0, 0, lastSnapshot.rate, "Session has no audio tracks"),
                    stopForeground = false,
                    syncFinalProgress = false
                )
            )
            return
        }

        this.currentSession = session
        this.accessToken = accessToken
        this.serverUrl = serverUrl

        val dataSourceFactory = DefaultHttpDataSource.Factory()
            .setUserAgent(NOTIFICATION_CHANNEL_ID)
            .setDefaultRequestProperties(mapOf("Authorization" to "Bearer $accessToken"))

        val sortedTracks = session.audioTracks.sortedBy { it.index }
        val mediaSource: MediaSource = if (sortedTracks.size == 1) {
            ProgressiveMediaSource.Factory(dataSourceFactory)
                .createMediaSource(MediaItem.fromUri(resolveTrackUrl(sortedTracks[0].contentUrl)))
        } else {
            val concatenating = ConcatenatingMediaSource()
            sortedTracks.forEach { track ->
                concatenating.addMediaSource(
                    ProgressiveMediaSource.Factory(dataSourceFactory)
                        .createMediaSource(MediaItem.fromUri(resolveTrackUrl(track.contentUrl)))
                )
            }
            concatenating
        }

        player.setMediaSource(mediaSource)
        player.seekTo((session.currentTime * 1000).toLong())
        player.prepare()
    }

    private fun resolveTrackUrl(contentUrl: String): String =
        if (contentUrl.startsWith("http://") || contentUrl.startsWith("https://")) contentUrl else "$serverUrl$contentUrl"

    fun play() {
        player.playWhenReady = true
    }

    fun pause() {
        player.playWhenReady = false
    }

    fun seekTo(positionMs: Long) {
        player.seekTo(positionMs.coerceAtLeast(0))
    }

    fun jumpForward() {
        seekTo(player.currentPosition + JUMP_FORWARD_MS)
    }

    fun jumpBackward() {
        seekTo(player.currentPosition - JUMP_BACKWARD_MS)
    }

    fun setRate(rate: Float) {
        player.playbackParameters = PlaybackParameters(rate)
    }

    fun setSleepTimer(seconds: Long?) {
        sleepCheckHandler.removeCallbacks(sleepCheckRunnable)
        if (seconds == null) {
            sleepTimerManager.cancel()
            return
        }
        sleepTimerManager.start(seconds)
        sleepCheckHandler.postDelayed(sleepCheckRunnable, 1_000)
    }

    /** Track-level skip (multi-track sessions only) -- chapter navigation is out of scope until
     * the [PlaybackSession] contract carries chapter data. */
    fun skipToNext() {
        if (player.hasNextMediaItem()) player.seekToNextMediaItem()
    }

    fun skipToPrevious() {
        if (player.hasPreviousMediaItem()) player.seekToPreviousMediaItem()
    }

    @Suppress("DEPRECATION")
    fun stop() {
        sleepCheckHandler.removeCallbacks(sleepCheckRunnable)
        sleepTimerManager.cancel()
        player.stop()
        currentSession = null
        lastSnapshot = PlayerSnapshot(PlayerStatus.IDLE, 0, 0, lastSnapshot.rate)
        stateEmitter?.onPlayerState(lastSnapshot)
        stopForeground(true)
        stopSelf()
    }

    fun getState(): PlayerSnapshot = lastSnapshot

    /** Called by [PlayerListener] with each reduced snapshot. */
    @Suppress("DEPRECATION")
    fun applyReducerResult(result: ReducerResult) {
        lastSnapshot = result.snapshot
        stateEmitter?.onPlayerState(result.snapshot)
        updateMediaSessionPlaybackState(result.snapshot)
        if (result.stopForeground) {
            stopForeground(true)
        }
    }

    private fun updateMediaSessionPlaybackState(snapshot: PlayerSnapshot) {
        val state = when (snapshot.status) {
            PlayerStatus.PLAYING -> PlaybackStateCompat.STATE_PLAYING
            PlayerStatus.PAUSED -> PlaybackStateCompat.STATE_PAUSED
            PlayerStatus.BUFFERING, PlayerStatus.LOADING -> PlaybackStateCompat.STATE_BUFFERING
            PlayerStatus.ENDED -> PlaybackStateCompat.STATE_STOPPED
            PlayerStatus.ERROR -> PlaybackStateCompat.STATE_ERROR
            PlayerStatus.IDLE -> PlaybackStateCompat.STATE_NONE
        }
        val actions = PlaybackStateCompat.ACTION_PLAY or PlaybackStateCompat.ACTION_PAUSE or
            PlaybackStateCompat.ACTION_SEEK_TO or PlaybackStateCompat.ACTION_FAST_FORWARD or
            PlaybackStateCompat.ACTION_REWIND or PlaybackStateCompat.ACTION_STOP
        mediaSession.setPlaybackState(
            PlaybackStateCompat.Builder()
                .setState(state, snapshot.currentTimeMs, snapshot.rate)
                .setActions(actions)
                .build()
        )
    }

    override fun onDestroy() {
        sleepCheckHandler.removeCallbacks(sleepCheckRunnable)
        if (::player.isInitialized) player.release()
        if (::mediaSession.isInitialized) mediaSession.release()
        super.onDestroy()
    }
}
