package com.hellofriend.shelfdroid.plugins

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.hellofriend.shelfdroid.data.AudioTrack
import com.hellofriend.shelfdroid.data.PlaybackSession
import com.hellofriend.shelfdroid.player.PlayerNotificationService
import com.hellofriend.shelfdroid.player.PlayerSnapshot

/**
 * Capacitor bridge implementing the exact TS-side contract
 * `mobile/src/native/absAudioPlayerPlugin.ts` defines (WI-1496 t700 Task 1):
 * load/play/pause/seek/setRate/stop/setSleepTimer/getState, plus a `playerState` listener event
 * shaped like TS's `NativePlayerState`.
 */
@CapacitorPlugin(name = "AbsAudioPlayer")
class AbsAudioPlayer : Plugin() {
    // Written on the main thread (ServiceConnection), read on Capacitor's plugin thread.
    @Volatile
    private var service: PlayerNotificationService? = null
    private var bound = false

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            val local = binder as PlayerNotificationService.LocalBinder
            val svc = local.getService()
            service = svc
            svc.stateEmitter = object : PlayerNotificationService.PlaybackStateEmitter {
                override fun onPlayerState(snapshot: PlayerSnapshot) {
                    notifyListeners("playerState", nativePlayerStateJs(snapshot))
                }
            }
            bound = true
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            service = null
            bound = false
        }
    }

    override fun load() {
        val intent = Intent(context, PlayerNotificationService::class.java)
        // Plain `startService`, not `startForegroundService`: the latter obliges the service to call
        // `startForeground()` within seconds or the system kills the app
        // (`ForegroundServiceDidNotStartInTimeException`), but this service only enters the
        // foreground once something is actually playing (PlayerNotificationListener), which may be
        // minutes after the WebView attaches. Starting it is allowed here because plugin load runs
        // with the activity in the foreground; the service is promoted later, on the user's play.
        try {
            context.startService(intent)
        } catch (e: IllegalStateException) {
            // Background-start restriction: binding below still creates the service, which is all
            // that is needed until playback starts.
            Log.w(TAG, "startService refused, relying on bind only: ${e.message}")
        }
        context.bindService(intent, connection, Context.BIND_AUTO_CREATE)
    }

    @PluginMethod
    fun load(call: PluginCall) {
        val svc = service ?: return call.reject("Native player service not bound yet")
        val sessionObj = call.getObject("session") ?: return call.reject("Missing 'session'")
        val accessToken = call.getString("accessToken") ?: ""
        val serverUrl = call.getString("serverUrl") ?: ""

        val tracksArray = sessionObj.getJSONArray("audioTracks")
        val tracks = (0 until tracksArray.length()).map { i ->
            val t = tracksArray.getJSONObject(i)
            AudioTrack(index = t.getInt("index"), contentUrl = t.getString("contentUrl"), duration = t.getDouble("duration"))
        }
        val session = PlaybackSession(
            id = sessionObj.getString("id") ?: return call.reject("Missing 'session.id'"),
            currentTime = sessionObj.optDouble("currentTime", 0.0),
            audioTracks = tracks
        )

        onMainThread(call) { svc.load(session, accessToken, serverUrl) }
    }

    @PluginMethod
    fun play(call: PluginCall) {
        val svc = service ?: return call.reject("Native player service not bound yet")
        onMainThread(call) { svc.play() }
    }

    @PluginMethod
    fun pause(call: PluginCall) {
        val svc = service ?: return call.reject("Native player service not bound yet")
        onMainThread(call) { svc.pause() }
    }

    @PluginMethod
    fun seek(call: PluginCall) {
        val svc = service ?: return call.reject("Native player service not bound yet")
        val seconds = call.getDouble("seconds") ?: 0.0
        onMainThread(call) { svc.seekTo((seconds * 1000).toLong()) }
    }

    @PluginMethod
    fun setRate(call: PluginCall) {
        val svc = service ?: return call.reject("Native player service not bound yet")
        val rate = call.getFloat("rate", 1f) ?: 1f
        onMainThread(call) { svc.setRate(rate) }
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        val svc = service ?: return call.reject("Native player service not bound yet")
        // `keepForeground`: JS is replacing the item and a `load()` follows -- see
        // PlayerNotificationService.stop for why the foreground service must survive the gap.
        val keepForeground = call.getBoolean("keepForeground", false) ?: false
        onMainThread(call) { svc.stop(keepForeground) }
    }

    @PluginMethod
    fun setSleepTimer(call: PluginCall) {
        val svc = service ?: return call.reject("Native player service not bound yet")
        val seconds = call.getDouble("seconds")?.toLong()
        onMainThread(call) { svc.setSleepTimer(seconds) }
    }

    @PluginMethod
    fun getState(call: PluginCall) {
        val svc = service
        if (svc != null) {
            bridge.executeOnMainThread { call.resolve(playerSnapshotJs(svc.getState(), svc.currentSession?.id)) }
            return
        }
        // WI-1496 t700 Task 4: `load()` (the Capacitor plugin lifecycle method above, not this
        // @PluginMethod) starts+binds the service asynchronously as soon as the WebView attaches.
        // A caller invoking getState() on mount to detect a recoverable session after cold start
        // (see PlayerProvider.tsx) can race that bind -- retry once, briefly, before giving up.
        Handler(Looper.getMainLooper()).postDelayed({
            val retried = service
            if (retried == null) {
                call.reject("Native player service not bound yet")
            } else {
                call.resolve(playerSnapshotJs(retried.getState(), retried.currentSession?.id))
            }
        }, GET_STATE_BIND_RETRY_MS)
    }

    /** Capacitor runs every `@PluginMethod` on its own "CapacitorPlugins" HandlerThread, but the
     * ExoPlayer inside [PlayerNotificationService] is built on the main looper and must only be
     * accessed from it. Runs [action] on the main thread and settles [call] there: resolves after
     * [action] returns, rejects if it throws -- exactly once either way, since [action] itself
     * never touches the call. */
    private fun onMainThread(call: PluginCall, action: () -> Unit) {
        bridge.executeOnMainThread {
            try {
                action()
                call.resolve()
            } catch (e: Exception) {
                call.reject(e.message ?: "Native player call failed", e)
            }
        }
    }

    /** Shapes a snapshot into TS's `NativePlayerState` (the `playerState` event payload):
     * `{state, currentTime, duration, playbackRate, playWhenReady, error?}`, seconds not milliseconds. */
    private fun nativePlayerStateJs(snapshot: PlayerSnapshot): JSObject {
        val obj = JSObject()
        obj.put("state", snapshot.status.name.lowercase())
        obj.put("currentTime", snapshot.currentTimeMs / 1000.0)
        obj.put("duration", snapshot.durationMs / 1000.0)
        obj.put("playbackRate", snapshot.rate)
        obj.put("playWhenReady", snapshot.playWhenReady)
        snapshot.error?.let { obj.put("error", it) }
        return obj
    }

    /** Shapes a snapshot into TS's `PlayerSnapshot` (the `getState()` return value):
     * `{status, itemId, currentTime, duration, error, rate, playWhenReady}`, seconds not milliseconds. */
    private fun playerSnapshotJs(snapshot: PlayerSnapshot, itemId: String?): JSObject {
        val obj = JSObject()
        obj.put("status", snapshot.status.name.lowercase())
        obj.put("itemId", itemId)
        obj.put("currentTime", snapshot.currentTimeMs / 1000.0)
        obj.put("duration", snapshot.durationMs / 1000.0)
        obj.put("rate", snapshot.rate)
        obj.put("playWhenReady", snapshot.playWhenReady)
        obj.put("error", snapshot.error)
        return obj
    }

    override fun handleOnDestroy() {
        if (bound) {
            context.unbindService(connection)
            bound = false
        }
        super.handleOnDestroy()
    }

    companion object {
        private const val TAG = "AbsAudioPlayer"
        private const val GET_STATE_BIND_RETRY_MS = 250L
    }
}
