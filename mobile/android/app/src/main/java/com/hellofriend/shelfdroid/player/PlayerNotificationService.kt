package com.hellofriend.shelfdroid.player

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.appwidget.AppWidgetManager
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
import com.hellofriend.shelfdroid.MediaPlayerWidget
import com.hellofriend.shelfdroid.PlayerCommand
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
import com.google.android.exoplayer2.upstream.DefaultDataSource
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

    /** Android Auto browse tree (WI-1496 t900 Task 1). Null until the JS side supplies a
     * [BrowseRepository] (cached ABS shelves + t800's offline catalog) via [setBrowseRepository]
     * -- browsing/voice search are unavailable before that first call, same as any other
     * cache-dependent feature. */
    private var browseTree: BrowseTree? = null

    /** Notified when Android Auto resolves a browse/search request to an already-known/cached
     * mediaId. This service never loads it itself (see [load]'s doc note); forwards to the JS
     * bridge, which owns ABS session-resolution + `load()`, exactly like any other play action. */
    var playbackRequestListener: PlaybackRequestListener? = null
        set(value) {
            field = value
            mediaSessionPlaybackPreparer = browseTree?.let { tree -> value?.let { MediaSessionPlaybackPreparer(tree, it) } }
        }

    private var mediaSessionPlaybackPreparer: MediaSessionPlaybackPreparer? = null

    fun setBrowseRepository(repository: BrowseRepository) {
        val tree = BrowseTree(repository)
        browseTree = tree
        mediaSessionPlaybackPreparer = playbackRequestListener?.let { MediaSessionPlaybackPreparer(tree, it) }
    }

    /** Called from [MediaSessionCallback.onPlayFromMediaId]. No-op (returns false) until
     * [setBrowseRepository] and [playbackRequestListener] have both been set. */
    fun preparePlaybackFromMediaId(mediaId: String): Boolean =
        mediaSessionPlaybackPreparer?.onPrepareFromMediaId(mediaId) ?: false

    /** Called from [MediaSessionCallback.onPlayFromSearch] (Android Auto voice search). */
    fun preparePlaybackFromSearch(query: String): Boolean =
        mediaSessionPlaybackPreparer?.onPrepareFromSearch(query) ?: false

    lateinit var player: ExoPlayer
        private set
    private lateinit var mediaSession: MediaSessionCompat
    private lateinit var playerNotificationManager: PlayerNotificationManager

    var currentSession: PlaybackSession? = null
        private set
    private var accessToken: String = ""
    private var serverUrl: String = ""

    private var lastSnapshot = PlayerSnapshot(PlayerStatus.IDLE, 0, 0, 1f)

    /** WI-1496 t700 Task 4: survives process death / service recreation. Real store is plain
     * SharedPreferences (see PlaybackStateStore's doc note on why unencrypted is fine here);
     * mutable + open for test injection, mirroring SecureSessionPlugin's `storeOverride`. */
    var stateStore: PlaybackStateStore = PlaybackStateStore(this)

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

    /** Routes the home-screen widget's explicit service `PendingIntent`s (WI-1496 t900 Task 2)
     * to the existing play/pause/jump command surface -- [MediaPlayerWidget.commandFor] is the
     * single source of truth for action-string -> command mapping. */
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (MediaPlayerWidget.commandFor(intent?.action)) {
            PlayerCommand.PLAY_PAUSE -> if (player.isPlaying) pause() else play()
            PlayerCommand.JUMP_BACK -> jumpBackward()
            PlayerCommand.JUMP_FORWARD -> jumpForward()
            null -> Unit
        }
        return START_NOT_STICKY
    }

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
        restoreRecoveryState()
    }

    /** Reads any [PlaybackStateStore] entry written by a prior instance of this service (this
     * process, an earlier process before it died, etc.) and surfaces it as a paused, recoverable
     * snapshot -- `currentSession`/`getState()` reflect it immediately, before any `load()` call
     * rebuilds a real ExoPlayer media source. Never touches the player or requests a token: full
     * resumption of audio is the JS side's job (re-fetch the token from `SecureSessionPlugin`,
     * call `load()` again) once it observes this recoverable state via `getState()`. */
    private fun restoreRecoveryState() {
        val stored = stateStore.load() ?: return
        currentSession = PlaybackStateStore.sessionFromJson(stored.sessionJson)
        lastSnapshot = PlayerSnapshot(PlayerStatus.PAUSED, stored.positionMs, lastSnapshot.durationMs, stored.rate)
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

        // WI-1496 t800 Task 5: `DefaultDataSource.Factory` wraps the HTTP factory but delegates to
        // `FileDataSource`/`ContentDataSource`/`AssetDataSource` internally for `file://`/
        // `content://`/`asset://` URIs -- required for offline playback, which passes a local
        // downloader-owned file/content URI (see `offlineSource.ts`'s `toLocalUri`) instead of a
        // server-relative or absolute HTTP URL. The HTTP path (streaming, the pre-existing
        // behavior) is unaffected: it's still exactly this same auth'd HTTP factory underneath.
        val httpDataSourceFactory = DefaultHttpDataSource.Factory()
            .setUserAgent(NOTIFICATION_CHANNEL_ID)
            .setDefaultRequestProperties(mapOf("Authorization" to "Bearer $accessToken"))
        val dataSourceFactory = DefaultDataSource.Factory(this, httpDataSourceFactory)

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

    /** WI-1496 t800 Task 5: `content://`/`file://` are already-complete local-playback URIs
     * (`offlineSource.ts`'s `toLocalUri` output) -- pass through untouched, exactly like the
     * pre-existing `http(s)://` case, rather than mistaking them for a server-relative path and
     * mangling them with `$serverUrl$contentUrl`. */
    private fun resolveTrackUrl(contentUrl: String): String =
        if (LOCAL_URI_SCHEMES.any { contentUrl.startsWith(it) }) contentUrl else "$serverUrl$contentUrl"

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
        stateStore.clear()
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
        persistRecoveryState(result.snapshot)
        notifyWidgets(result.snapshot)
        if (result.stopForeground) {
            stopForeground(true)
        }
    }

    /** Pushes the latest snapshot to every home-screen widget instance (WI-1496 t900 Task 2) --
     * a no-op when zero widgets are placed ([MediaPlayerWidget.widgetIds] returns an empty
     * array). See [MediaPlayerWidget]'s class doc for the title/author placeholder-text gap. */
    private fun notifyWidgets(snapshot: PlayerSnapshot) {
        val appWidgetManager = AppWidgetManager.getInstance(this)
        MediaPlayerWidget.widgetIds(this).forEach { id ->
            MediaPlayerWidget.updateAppWidget(
                context = this,
                appWidgetManager = appWidgetManager,
                appWidgetId = id,
                isPlaying = snapshot.status == PlayerStatus.PLAYING,
                hasSession = currentSession != null
            )
        }
    }

    /** Persists (playing/buffering/paused) or clears (ended/error/idle) the recovery snapshot on
     * every reduced player event -- cheaper than trying to catch every possible teardown path
     * individually, and self-correcting if one is missed. Never persists [accessToken]. */
    private fun persistRecoveryState(snapshot: PlayerSnapshot) {
        when (snapshot.status) {
            PlayerStatus.PLAYING, PlayerStatus.BUFFERING, PlayerStatus.PAUSED -> {
                val session = currentSession ?: return
                stateStore.save(
                    StoredPlaybackState(
                        sessionId = session.id,
                        libraryItemId = session.id,
                        sessionJson = PlaybackStateStore.sessionToJson(session),
                        positionMs = snapshot.currentTimeMs,
                        rate = snapshot.rate,
                        shouldResume = snapshot.status == PlayerStatus.PLAYING,
                        serverUrlFingerprint = serverUrl,
                        updatedAt = System.currentTimeMillis()
                    )
                )
            }
            PlayerStatus.ENDED, PlayerStatus.ERROR, PlayerStatus.IDLE -> stateStore.clear()
            else -> Unit
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
