package com.hellofriend.shelfdroid.services

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.StatFs
import androidx.core.content.ContextCompat
import com.hellofriend.shelfdroid.EncryptedSecureStore
import com.hellofriend.shelfdroid.SecureStore
import com.hellofriend.shelfdroid.managers.ConnectivityPolicy
import com.hellofriend.shelfdroid.managers.DbManager
import com.hellofriend.shelfdroid.managers.DbManagerDownloadRepository
import com.hellofriend.shelfdroid.managers.DiskSpacePolicy
import com.hellofriend.shelfdroid.managers.DownloadEventListener
import com.hellofriend.shelfdroid.managers.DownloadItemManager
import com.hellofriend.shelfdroid.models.DownloadItem
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.logging.Level
import java.util.logging.Logger
import kotlin.math.max
import org.json.JSONObject

/**
 * Process-wide owner of the single [DownloadItemManager], shared by the foreground [DownloadService]
 * and the `AbsDownloader` Capacitor bridge (WI-1496 t800 Task 3), mirroring the donor app's
 * `DownloadServiceHost` object. Untested on this machine (needs a real `Context` --
 * `ConnectivityManager`/`StatFs` aren't available under `testOptions.unitTests.returnDefaultValues`),
 * same class of gap as every other `Context`-bound class this session (`AbsFileSystem`,
 * `PlayerNotificationService`).
 *
 * Tokens are never written to `downloads.json` (see `DownloadItemManager`'s doc). The token a
 * transfer uses is resolved per request: the app's own encrypted session vault
 * (`EncryptedSecureStore`, the same store `SecureSessionPlugin` persists the signed-in session in,
 * which the JS side keeps refreshed) when its server matches the item's server, falling back to
 * the in-memory token [setToken] recorded at `enqueue()` time. That makes downloads survive a
 * process kill: after a restore the in-memory map is empty but the vault still holds the session.
 *
 * Also owns the single shared [DbManager] (so concurrent callers share one lock), the
 * `wifiOnly` preference the JS settings screen pushes in, and a `ConnectivityManager`
 * network callback that is registered only while there is download work and nudges parts parked
 * on `waiting_for_network` to retry.
 */
object DownloadServiceHost {
    private val LOG: Logger = Logger.getLogger("DownloadServiceHost")

    @Volatile
    private var manager: DownloadItemManager? = null
    private var service: DownloadService? = null
    private var bridgeListener: DownloadEventListener = DownloadEventListener.NOOP
    private val tokens = ConcurrentHashMap<String, String>()

    private var database: DbManager? = null
    private val storeLock = Any()
    private var secureStore: SecureStore? = null

    @Volatile
    private var wifiOnly: Boolean = true
    private var wifiOnlyLoaded = false

    private val networkLock = Any()
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var networkManager: ConnectivityManager? = null

    @Synchronized
    fun setToken(itemId: String, token: String) {
        tokens[itemId] = token
    }

    /** The one shared [DbManager] for this process -- every plugin and the manager go through it
     * so index reads/writes serialize on a single lock. */
    @Synchronized
    fun database(context: Context): DbManager {
        val existing = database
        if (existing != null) return existing
        val created = DbManager(File(context.applicationContext.filesDir, "shelfdroid_db"))
        database = created
        return created
    }

    @Synchronized
    fun ensure(context: Context): DownloadItemManager {
        val existing = manager
        if (existing != null) return existing
        val appContext = context.applicationContext
        loadWifiOnly(appContext)
        val created = DownloadItemManager(
            repository = DbManagerDownloadRepository(database(appContext)),
            tokenProvider = { id -> tokenFor(appContext, id) },
            refreshToken = { id -> tokenFor(appContext, id) },
            connectivity = ConnectivityPolicy { transferAllowed(appContext) },
            diskSpace = statFsPolicy(),
            listener = object : DownloadEventListener {
                override fun onItemUpdated(item: DownloadItem) {
                    service?.onItemUpdated(item)
                    bridgeListener.onItemUpdated(item)
                }

                override fun onItemComplete(item: DownloadItem) {
                    service?.onItemComplete(item)
                    bridgeListener.onItemComplete(item)
                }

                override fun onQueueChanged(hasWork: Boolean) {
                    updateNetworkWatch(appContext, hasWork)
                    service?.onQueueChanged(hasWork)
                    bridgeListener.onQueueChanged(hasWork)
                }
            }
        )
        manager = created
        created.restoreQueue()
        return created
    }

    /** Attaches the JS-facing bridge's event forwarder -- `AbsDownloader.load()`/`handleOnDestroy()`
     * call this pair, matching `attachService`/`detachService`'s split (two independent listener
     * slots, both fed by the single manager-owned [DownloadEventListener] above). */
    @Synchronized
    fun attachBridge(listener: DownloadEventListener) {
        bridgeListener = listener
    }

    @Synchronized
    fun detachBridge() {
        bridgeListener = DownloadEventListener.NOOP
    }

    @Synchronized
    fun attachService(downloadService: DownloadService) {
        service = downloadService
    }

    @Synchronized
    fun detachService(downloadService: DownloadService) {
        if (service === downloadService) service = null
    }

    fun startService(context: Context) {
        ContextCompat.startForegroundService(context, DownloadService.intent(context))
    }

    /** Stops download work and releases the network callback -- for process/plugin teardown. */
    @Synchronized
    fun shutdown() {
        unregisterNetworkCallback()
        manager?.destroy()
        manager = null
    }

    // ---- Removing a downloaded book ----

    /** Deletes a downloaded (or part-downloaded) book completely: stops its transfer, drops its
     * queue rows (in memory and in `downloads.json`, so a restart cannot resurrect it and a
     * re-download is not blocked by a stale id), removes its local library row and deletes its
     * files. Shared by `AbsDownloader.remove` and `AbsFileSystem.deleteLocalItem`. */
    fun removeLocal(context: Context, libraryItemId: String) {
        val appContext = context.applicationContext
        val local = database(appContext).localItem(libraryItemId)
        ensure(appContext).removeDownloaded(libraryItemId)
        // Internal-storage folders only: SAF (`content://`) deletion needs a DocumentFile round
        // trip that this milestone does not implement.
        if (local != null && !local.folderUri.startsWith("content://")) {
            File(local.folderUri).deleteRecursively()
        }
    }

    // ---- Wi-Fi-only preference ----

    /** Records the JS `wifiOnly` setting (also persisted natively so a service restored after a
     * process kill, before any JS runs, applies the user's choice). Relaxing it retries parts
     * parked on the network. */
    @Synchronized
    fun setWifiOnly(context: Context, value: Boolean) {
        val appContext = context.applicationContext
        loadWifiOnly(appContext)
        val relaxed = wifiOnly && !value
        wifiOnly = value
        appContext.getSharedPreferences(POLICY_PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_WIFI_ONLY, value).apply()
        if (relaxed) manager?.retryWaiting()
    }

    private fun loadWifiOnly(appContext: Context) {
        if (wifiOnlyLoaded) return
        // Conservative until the user says otherwise: never spend cellular data unprompted.
        wifiOnly = appContext.getSharedPreferences(POLICY_PREFS, Context.MODE_PRIVATE).getBoolean(KEY_WIFI_ONLY, true)
        wifiOnlyLoaded = true
    }

    /** Transfers are allowed on any validated-internet network when `wifiOnly` is off; with it
     * on, on any unmetered network -- Wi-Fi, Ethernet, or a VPN over either -- but not metered
     * cellular. */
    private fun transferAllowed(appContext: Context): Boolean {
        val cm = appContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return false
        val network = cm.activeNetwork ?: return false
        val capabilities = cm.getNetworkCapabilities(network) ?: return false
        if (!capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) return false
        if (!wifiOnly) return true
        return capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) ||
            capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) ||
            !cm.isActiveNetworkMetered
    }

    // ---- Network availability watch ----

    /** Registers a default-network callback while there is download work and unregisters it when
     * the queue goes idle, so nothing leaks and nothing wakes the app needlessly. */
    private fun updateNetworkWatch(appContext: Context, hasWork: Boolean) {
        synchronized(networkLock) {
            if (!hasWork) {
                unregisterNetworkCallback()
                return
            }
            if (networkCallback != null) return
            val cm = appContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
            val callback = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    manager?.retryWaiting()
                }

                override fun onCapabilitiesChanged(network: Network, networkCapabilities: NetworkCapabilities) {
                    manager?.retryWaiting()
                }
            }
            try {
                cm.registerDefaultNetworkCallback(callback)
                networkCallback = callback
                networkManager = cm
            } catch (e: RuntimeException) {
                LOG.log(Level.WARNING, "Could not register the network callback; parked downloads will only retry on resume", e)
            }
        }
    }

    private fun unregisterNetworkCallback() {
        synchronized(networkLock) {
            val callback = networkCallback ?: return
            try {
                networkManager?.unregisterNetworkCallback(callback)
            } catch (e: RuntimeException) {
                LOG.log(Level.WARNING, "Could not unregister the network callback", e)
            }
            networkCallback = null
            networkManager = null
        }
    }

    // ---- Tokens ----

    /** The freshest token usable for [itemId]'s server: the encrypted session vault's access
     * token when the vault session is for the same server as the item (never hand a token to a
     * different server), else the in-memory token supplied at `enqueue()`. */
    private fun tokenFor(appContext: Context, itemId: String): String? {
        val serverUrl = manager?.item(itemId)?.serverUrl
        val vaultToken = readVaultSession(appContext)
            ?.takeIf { serverUrl != null && sameServer(it.optString("serverUrl"), serverUrl) }
            ?.optString("accessToken")
            ?.takeIf { it.isNotBlank() }
        return vaultToken ?: tokens[itemId]
    }

    private fun readVaultSession(appContext: Context): JSONObject? {
        return try {
            val store = synchronized(storeLock) { secureStore ?: EncryptedSecureStore(appContext).also { secureStore = it } }
            store.read()?.let { JSONObject(it) }
        } catch (e: Exception) {
            LOG.log(Level.WARNING, "Could not read the stored session for a download token", e)
            null
        }
    }

    private fun sameServer(a: String, b: String): Boolean = a.trim().trimEnd('/').equals(b.trim().trimEnd('/'), ignoreCase = true)

    private fun statFsPolicy(): DiskSpacePolicy = DiskSpacePolicy { target ->
        val dir = (target.parentFile ?: target).apply { mkdirs() }
        if (!dir.exists()) return@DiskSpacePolicy false
        val stat = StatFs(dir.absolutePath)
        val available = stat.availableBytes
        available >= max(MIN_FREE_SPACE_BYTES, stat.totalBytes / 20L)
    }

    private const val MIN_FREE_SPACE_BYTES = 100L * 1024L * 1024L
    private const val POLICY_PREFS = "shelfdroid_download_policy"
    private const val KEY_WIFI_ONLY = "wifi_only"
}
