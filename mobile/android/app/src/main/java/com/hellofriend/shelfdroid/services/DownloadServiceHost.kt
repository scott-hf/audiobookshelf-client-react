package com.hellofriend.shelfdroid.services

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.StatFs
import androidx.core.content.ContextCompat
import com.hellofriend.shelfdroid.managers.ConnectivityPolicy
import com.hellofriend.shelfdroid.managers.DbManager
import com.hellofriend.shelfdroid.managers.DbManagerDownloadRepository
import com.hellofriend.shelfdroid.managers.DiskSpacePolicy
import com.hellofriend.shelfdroid.managers.DownloadEventListener
import com.hellofriend.shelfdroid.managers.DownloadItemManager
import com.hellofriend.shelfdroid.models.DownloadItem
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.max

/**
 * Process-wide owner of the single [DownloadItemManager], shared by the foreground [DownloadService]
 * and the `AbsDownloader` Capacitor bridge (WI-1496 t800 Task 3), mirroring the donor app's
 * `DownloadServiceHost` object. Untested on this machine (needs a real `Context` --
 * `ConnectivityManager`/`StatFs` aren't available under `testOptions.unitTests.returnDefaultValues`),
 * same class of gap as every other `Context`-bound class this session (`AbsFileSystem`,
 * `PlayerNotificationService`).
 *
 * Tokens are never persisted (see `DownloadItemManager`'s doc): [setToken] is called by
 * `AbsDownloader.enqueue()` with the access token the JS side supplied at that moment and kept
 * only in the in-memory [tokens] map for the life of the process; `refreshToken` re-reads the
 * same map (there is no separate OAuth refresh flow in this milestone -- if JS re-authenticates
 * it should call `setToken` again with the new value before retrying a stuck download).
 */
object DownloadServiceHost {
    private var manager: DownloadItemManager? = null
    private var service: DownloadService? = null
    private var bridgeListener: DownloadEventListener = DownloadEventListener.NOOP
    private val tokens = ConcurrentHashMap<String, String>()

    @Synchronized
    fun setToken(itemId: String, token: String) {
        tokens[itemId] = token
    }

    @Synchronized
    fun ensure(context: Context): DownloadItemManager {
        val existing = manager
        if (existing != null) return existing
        val appContext = context.applicationContext
        val dbManager = DbManager(File(appContext.filesDir, "shelfdroid_db"))
        val created = DownloadItemManager(
            repository = DbManagerDownloadRepository(dbManager),
            tokenProvider = { id -> tokens[id] },
            refreshToken = { id -> tokens[id] },
            connectivity = wifiOnlyPolicy(appContext),
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

    /** Wi-Fi-only transfer policy: refuses cellular/no connectivity. A future settings screen
     * could make this user-configurable; this milestone's plan only specifies "honor Wi-Fi-only
     * policy", so it is unconditional for now. */
    private fun wifiOnlyPolicy(context: Context): ConnectivityPolicy = ConnectivityPolicy {
        val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return@ConnectivityPolicy false
        val network = manager.activeNetwork ?: return@ConnectivityPolicy false
        val capabilities = manager.getNetworkCapabilities(network) ?: return@ConnectivityPolicy false
        capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
    }

    private fun statFsPolicy(): DiskSpacePolicy = DiskSpacePolicy { target ->
        val dir = (target.parentFile ?: target).apply { mkdirs() }
        if (!dir.exists()) return@DiskSpacePolicy false
        val stat = StatFs(dir.absolutePath)
        val available = stat.availableBytes
        available >= max(MIN_FREE_SPACE_BYTES, stat.totalBytes / 20L)
    }

    private const val MIN_FREE_SPACE_BYTES = 100L * 1024L * 1024L
}
