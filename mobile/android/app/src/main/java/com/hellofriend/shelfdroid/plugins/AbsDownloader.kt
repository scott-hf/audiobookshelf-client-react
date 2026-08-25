package com.hellofriend.shelfdroid.plugins

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.hellofriend.shelfdroid.device.FolderScanner
import com.hellofriend.shelfdroid.managers.DbManager
import com.hellofriend.shelfdroid.managers.DownloadEventListener
import com.hellofriend.shelfdroid.managers.DownloadItemManager
import com.hellofriend.shelfdroid.models.DownloadItem
import com.hellofriend.shelfdroid.models.DownloadItemPart
import com.hellofriend.shelfdroid.services.DownloadService
import com.hellofriend.shelfdroid.services.DownloadServiceHost
import java.io.File

/**
 * Capacitor bridge implementing the exact TS-side contract
 * `mobile/src/native/absDownloaderPlugin.ts` defines (WI-1496 t800 Task 1):
 * enqueue/pause/resume/cancel/remove/listQueue, plus `downloadProgress`/`downloadComplete`/
 * `downloadFailed` listener events shaped like TS's `RawDownloadEvent`. Adapted from the donor
 * app's much larger `plugins/AbsDownloader.kt` (podcast episodes, SAF local-folder picking,
 * server-side library-item re-fetch) down to what this milestone's locked Task 1 contract
 * actually carries.
 *
 * DESIGN NOTE (flagged per the Task 3 dispatch's verification contract): the donor ports "every
 * audio track plus cover and ebook where present". Task 1's `AbsDownloaderEnqueueOptions` (already
 * committed, out of this dispatch's scope to revise) only carries `session: AbsPlaybackSession`,
 * whose `audioTracks` is the ONLY track/file info available here -- `AbsPlaybackSession` has no
 * `coverPath`/`ebookFile` field (see `mobile/src/types/abs.ts`). This dispatch therefore downloads
 * audio tracks only; cover/ebook support needs a Task 1 contract change (a follow-up, not
 * something Task 3 can retrofit without breaking the locked TS bridge).
 */
@CapacitorPlugin(name = "AbsDownloader")
class AbsDownloader : Plugin() {
    private val downloadItemManager: DownloadItemManager get() = DownloadServiceHost.ensure(context)
    private val dbManager: DbManager get() = DbManager(File(context.filesDir, "shelfdroid_db"))

    private val clientEventListener = object : DownloadEventListener {
        override fun onItemUpdated(item: DownloadItem) {
            val event = if (item.state == "failed") "downloadFailed" else "downloadProgress"
            notifyListeners(event, snapshotJs(item))
        }

        override fun onItemComplete(item: DownloadItem) {
            notifyListeners("downloadComplete", snapshotJs(item))
        }

        override fun onQueueChanged(hasWork: Boolean) {
            // No dedicated TS event for this -- `DownloadService` (the foreground notification)
            // is the only other `onQueueChanged` consumer; `downloadProgress`/`downloadComplete`
            // already cover what the React queue UI (Task 4) needs per snapshot.
        }
    }

    override fun load() {
        // Ensures the process-wide manager exists (and restores its persisted queue) before the
        // frontend can call enqueue/listQueue, then attaches this plugin's listener so
        // DownloadServiceHost forwards downloadProgress/downloadComplete to notifyListeners.
        downloadItemManager
        DownloadServiceHost.attachBridge(clientEventListener)
    }

    override fun handleOnDestroy() {
        DownloadServiceHost.detachBridge()
        super.handleOnDestroy()
    }

    @PluginMethod
    fun enqueue(call: PluginCall) {
        val libraryItemId = call.getString("libraryItemId") ?: return call.reject("Missing 'libraryItemId'")
        val title = call.getString("title") ?: libraryItemId
        val session = call.getObject("session") ?: return call.reject("Missing 'session'")
        val accessToken = call.getString("accessToken") ?: return call.reject("Missing 'accessToken'")
        val serverUrl = call.getString("serverUrl") ?: return call.reject("Missing 'serverUrl'")
        val serverConnectionId = call.getString("serverConnectionId") ?: return call.reject("Missing 'serverConnectionId'")

        val tracksArray = session.getJSONArray("audioTracks")
        if (tracksArray == null || tracksArray.length() == 0) return call.reject("Session has no audio tracks")

        val itemFolder = FolderScanner.finalInternalPath(context.filesDir, serverConnectionId, libraryItemId)
        val stagingFolder = File(File(context.filesDir, "download-staging"), FolderScanner.safeId(libraryItemId))

        val parts = (0 until tracksArray.length()).map { i ->
            val track = tracksArray.getJSONObject(i)
            val index = track.getInt("index")
            val contentUrl = track.getString("contentUrl")
            val filename = "track-$index${extensionFrom(contentUrl)}"
            DownloadItemPart(
                id = "$libraryItemId-$index",
                downloadItemId = libraryItemId,
                trackIndex = index,
                filename = filename,
                serverPath = contentUrl,
                finalDestinationPath = File(itemFolder, filename).absolutePath,
                stagingPath = File(stagingFolder, "$filename.part").absolutePath
            )
        }.toMutableList()

        val downloadItem = DownloadItem(
            id = libraryItemId,
            libraryItemId = libraryItemId,
            title = title,
            serverConnectionId = serverConnectionId,
            serverUrl = serverUrl,
            parts = parts
        )

        DownloadServiceHost.setToken(libraryItemId, accessToken)
        val manager = downloadItemManager
        manager.enqueue(downloadItem)
        DownloadServiceHost.startService(context)

        call.resolve(JSObject().put("id", downloadItem.id))
    }

    @PluginMethod
    fun pause(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject("Missing 'id'")
        downloadItemManager.pause(id)
        call.resolve()
    }

    @PluginMethod
    fun resume(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject("Missing 'id'")
        downloadItemManager.resume(id)
        call.resolve()
    }

    @PluginMethod
    fun cancel(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject("Missing 'id'")
        downloadItemManager.cancel(id)
        call.resolve()
    }

    @PluginMethod
    fun remove(call: PluginCall) {
        val libraryItemId = call.getString("libraryItemId") ?: return call.reject("Missing 'libraryItemId'")
        val local = dbManager.localItem(libraryItemId)
        if (local != null) {
            File(local.folderUri).deleteRecursively()
            dbManager.removeLocalItem(libraryItemId)
        }
        call.resolve()
    }

    @PluginMethod
    fun listQueue(call: PluginCall) {
        val array = com.getcapacitor.JSArray()
        downloadItemManager.listQueue().forEach { array.put(snapshotJs(it)) }
        call.resolve(JSObject().put("items", array))
    }

    /** Replays current queue state when the frontend subscribes, matching `AbsAudioPlayer`'s
     * `getState()` "catch up a late listener" pattern used elsewhere in this bridge layer. */
    @PluginMethod(returnType = PluginMethod.RETURN_NONE)
    override fun addListener(call: PluginCall) {
        super.addListener(call)
        if (call.getString("eventName") == "downloadProgress") {
            downloadItemManager.listQueue().forEach { notifyListeners("downloadProgress", snapshotJs(it)) }
        }
    }

    private fun snapshotJs(item: DownloadItem): JSObject = JSObject()
        .put("id", item.id)
        .put("libraryItemId", item.libraryItemId)
        .put("title", item.title)
        .put("bytesDownloaded", item.bytesDownloaded)
        .put("totalBytes", item.totalBytes)
        .put("state", item.state)
        .put("error", item.error)

    private fun extensionFrom(contentUrl: String): String {
        val path = contentUrl.substringBefore('?')
        val lastSegment = path.substringAfterLast('/')
        val dotIndex = lastSegment.lastIndexOf('.')
        return if (dotIndex > 0) lastSegment.substring(dotIndex) else ""
    }
}
