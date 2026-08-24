package com.hellofriend.shelfdroid

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

private const val PREFS_NAME = "shelfdroid_secure_session"
private const val KEY_SESSION = "session"

/** Minimal storage seam so SecureSessionPlugin's dispatch logic is unit-testable on the JVM
 * without the Android Keystore (see SecureSessionPluginTest.kt's FakeSecureStore). */
interface SecureStore {
    fun read(): String?
    fun write(value: String)
    fun clear()
}

/** Real implementation: one JSON session blob (serverUrl/accessToken/refreshToken) in
 * AndroidX Security's EncryptedSharedPreferences (AES256_GCM value, AES256_SIV keys). This is
 * the ONLY place ABS auth tokens are persisted on-device -- the WebView side never writes them
 * to localStorage/IndexedDB. */
class EncryptedSecureStore(private val context: Context) : SecureStore {
    private val preferences by lazy {
        val masterKey = MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        EncryptedSharedPreferences.create(
            context,
            PREFS_NAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }

    override fun read(): String? = preferences.getString(KEY_SESSION, null)

    override fun write(value: String) {
        preferences.edit().putString(KEY_SESSION, value).apply()
    }

    override fun clear() {
        preferences.edit().remove(KEY_SESSION).apply()
    }
}

@CapacitorPlugin(name = "SecureSession")
class SecureSessionPlugin : Plugin() {
    // Assigned directly by unit tests (FakeSecureStore) to skip the Android Keystore entirely.
    // Production leaves this null and lazily builds the real encrypted store on first use.
    internal var storeOverride: SecureStore? = null

    private fun store(): SecureStore = storeOverride ?: EncryptedSecureStore(context).also { storeOverride = it }

    @PluginMethod
    fun read(call: PluginCall) {
        val result = JSObject()
        result.put("value", store().read())
        call.resolve(result)
    }

    @PluginMethod
    fun write(call: PluginCall) {
        val value = call.getString("value")
        if (value == null) {
            call.reject("Missing 'value'")
            return
        }
        store().write(value)
        call.resolve()
    }

    @PluginMethod
    fun clear(call: PluginCall) {
        store().clear()
        call.resolve()
    }
}
