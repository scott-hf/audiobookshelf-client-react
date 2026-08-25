package com.hellofriend.shelfdroid.plugins

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.content.ContextCompat
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
        ContextCompat.startForegroundService(context, intent)
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

        svc.load(session, accessToken, serverUrl)
        call.resolve()
    }

    @PluginMethod
    fun play(call: PluginCall) {
        val svc = service ?: return call.reject("Native player service not bound yet")
        svc.play()
        call.resolve()
    }

    @PluginMethod
    fun pause(call: PluginCall) {
        val svc = service ?: return call.reject("Native player service not bound yet")
        svc.pause()
        call.resolve()
    }

    @PluginMethod
    fun seek(call: PluginCall) {
        val svc = service ?: return call.reject("Native player service not bound yet")
        val seconds = call.getDouble("seconds") ?: 0.0
        svc.seekTo((seconds * 1000).toLong())
        call.resolve()
    }

    @PluginMethod
    fun setRate(call: PluginCall) {
        val svc = service ?: return call.reject("Native player service not bound yet")
        val rate = call.getFloat("rate", 1f) ?: 1f
        svc.setRate(rate)
        call.resolve()
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        val svc = service ?: return call.reject("Native player service not bound yet")
        svc.stop()
        call.resolve()
    }

    @PluginMethod
    fun setSleepTimer(call: PluginCall) {
        val svc = service ?: return call.reject("Native player service not bound yet")
        val seconds = call.getDouble("seconds")?.toLong()
        svc.setSleepTimer(seconds)
        call.resolve()
    }

    @PluginMethod
    fun getState(call: PluginCall) {
        val svc = service
        if (svc != null) {
            call.resolve(playerSnapshotJs(svc.getState(), svc.currentSession?.id))
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

    /** Shapes a snapshot into TS's `NativePlayerState` (the `playerState` event payload):
     * `{state, currentTime, duration, playbackRate, error?}`, seconds not milliseconds. */
    private fun nativePlayerStateJs(snapshot: PlayerSnapshot): JSObject {
        val obj = JSObject()
        obj.put("state", snapshot.status.name.lowercase())
        obj.put("currentTime", snapshot.currentTimeMs / 1000.0)
        obj.put("duration", snapshot.durationMs / 1000.0)
        obj.put("playbackRate", snapshot.rate)
        snapshot.error?.let { obj.put("error", it) }
        return obj
    }

    /** Shapes a snapshot into TS's `PlayerSnapshot` (the `getState()` return value):
     * `{status, itemId, currentTime, duration, error, rate}`, seconds not milliseconds. */
    private fun playerSnapshotJs(snapshot: PlayerSnapshot, itemId: String?): JSObject {
        val obj = JSObject()
        obj.put("status", snapshot.status.name.lowercase())
        obj.put("itemId", itemId)
        obj.put("currentTime", snapshot.currentTimeMs / 1000.0)
        obj.put("duration", snapshot.durationMs / 1000.0)
        obj.put("rate", snapshot.rate)
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
        private const val GET_STATE_BIND_RETRY_MS = 250L
    }
}
