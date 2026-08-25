package com.hellofriend.shelfdroid.player

import android.content.Context
import com.hellofriend.shelfdroid.data.AudioTrack
import com.hellofriend.shelfdroid.data.PlaybackSession
import org.json.JSONArray
import org.json.JSONObject

private const val PREFS_NAME = "shelfdroid_playback_state"
private const val KEY_STATE = "state"

/**
 * Minimal recovery snapshot persisted across process death / service recreation so a cold start
 * can offer to resume the last session (WI-1496 t700 Task 4). Deliberately excludes the access
 * token -- [PlayerProvider]'s restore path re-reads the current token from `SecureSessionPlugin`
 * instead of ever duplicating it here. `serverUrlFingerprint` (the raw server URL string) is not
 * in the plan doc's illustrative `StoredPlaybackState` snippet but IS called out in its prose
 * ("server URL fingerprint") -- added because restoring position/rate against the wrong
 * configured server would be silently wrong.
 */
data class StoredPlaybackState(
    val sessionId: String,
    val libraryItemId: String,
    val sessionJson: String,
    val positionMs: Long,
    val rate: Float,
    val shouldResume: Boolean,
    val serverUrlFingerprint: String,
    val updatedAt: Long
)

/** Storage seam so [PlaybackStateStore]'s JSON encode/decode is unit-testable on the JVM without
 * a real SharedPreferences instance (mirrors SecureSessionPlugin's `SecureStore`/
 * `EncryptedSecureStore` pattern). Unlike that plugin's store, nothing sensitive is ever written
 * here, so plain (unencrypted) SharedPreferences is fine. */
interface PlaybackStorage {
    fun read(): String?
    fun write(value: String)
    fun clear()
}

class SharedPrefsPlaybackStorage(context: Context) : PlaybackStorage {
    private val preferences = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    override fun read(): String? = preferences.getString(KEY_STATE, null)

    override fun write(value: String) {
        preferences.edit().putString(KEY_STATE, value).apply()
    }

    override fun clear() {
        preferences.edit().remove(KEY_STATE).apply()
    }
}

/**
 * Persists/restores a single [StoredPlaybackState] as JSON. [PlayerNotificationService] writes
 * on every playing/buffering/paused snapshot and on `stop()`, and reads it once in `onCreate()`
 * so a freshly (re)started service instance can report a paused, recoverable session via
 * `getState()` before any `load()` call rebuilds an actual ExoPlayer media source.
 */
class PlaybackStateStore(private val storage: PlaybackStorage) {
    constructor(context: Context) : this(SharedPrefsPlaybackStorage(context))

    fun save(state: StoredPlaybackState) {
        val obj = JSONObject()
        obj.put("sessionId", state.sessionId)
        obj.put("libraryItemId", state.libraryItemId)
        obj.put("sessionJson", state.sessionJson)
        obj.put("positionMs", state.positionMs)
        obj.put("rate", state.rate.toDouble())
        obj.put("shouldResume", state.shouldResume)
        obj.put("serverUrlFingerprint", state.serverUrlFingerprint)
        obj.put("updatedAt", state.updatedAt)
        storage.write(obj.toString())
    }

    fun load(): StoredPlaybackState? {
        val raw = storage.read() ?: return null
        return try {
            val obj = JSONObject(raw)
            StoredPlaybackState(
                sessionId = obj.getString("sessionId"),
                libraryItemId = obj.getString("libraryItemId"),
                sessionJson = obj.getString("sessionJson"),
                positionMs = obj.getLong("positionMs"),
                rate = obj.getDouble("rate").toFloat(),
                shouldResume = obj.getBoolean("shouldResume"),
                serverUrlFingerprint = obj.optString("serverUrlFingerprint", ""),
                updatedAt = obj.getLong("updatedAt")
            )
        } catch (e: Exception) {
            null
        }
    }

    fun clear() = storage.clear()

    companion object {
        /** Serializes a [PlaybackSession] into the JSON stored in
         * [StoredPlaybackState.sessionJson], mirroring the shape `AbsAudioPlayer.kt#load` parses
         * out of the Capacitor call's `session` object. */
        fun sessionToJson(session: PlaybackSession): String {
            val obj = JSONObject()
            obj.put("id", session.id)
            obj.put("currentTime", session.currentTime)
            val tracks = JSONArray()
            session.audioTracks.forEach { track ->
                val t = JSONObject()
                t.put("index", track.index)
                t.put("contentUrl", track.contentUrl)
                t.put("duration", track.duration)
                tracks.put(t)
            }
            obj.put("audioTracks", tracks)
            return obj.toString()
        }

        fun sessionFromJson(json: String): PlaybackSession {
            val obj = JSONObject(json)
            val tracksArray = obj.getJSONArray("audioTracks")
            val tracks = (0 until tracksArray.length()).map { i ->
                val t = tracksArray.getJSONObject(i)
                AudioTrack(index = t.getInt("index"), contentUrl = t.getString("contentUrl"), duration = t.getDouble("duration"))
            }
            return PlaybackSession(id = obj.getString("id"), currentTime = obj.getDouble("currentTime"), audioTracks = tracks)
        }
    }
}
