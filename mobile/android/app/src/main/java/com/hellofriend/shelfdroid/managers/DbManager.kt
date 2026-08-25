package com.hellofriend.shelfdroid.managers

import com.hellofriend.shelfdroid.data.LocalLibraryItem
import com.hellofriend.shelfdroid.models.DownloadItem
import com.hellofriend.shelfdroid.models.DownloadItemPart
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

private const val DOWNLOADS_FILE = "downloads.json"
private const val LOCAL_ITEMS_FILE = "local_library_items.json"

/**
 * Minimal offline-catalog persistence (WI-1496 t800 Task 2), adapted from the donor app's
 * Paper-DB-backed `managers/DbManager.kt` down to the two collections this milestone's bridge
 * actually needs (`DownloadItem` queue rows, `LocalLibraryItem` completed-download rows) --
 * matching the TS `DownloadSnapshot`/`LocalLibraryItem` contracts from Task 1 field-for-field.
 * Backed by two plain JSON files under [baseDir] rather than a database dependency: kept
 * deliberately free of any `android.*` type so it's directly JVM-unit-testable (same "testable
 * core, thin Android shell" pattern as `PlayerStateReducer`/`SecureSessionPlugin`'s
 * `SecureStore`/`PlaybackStateStore`'s `PlaybackStorage`) -- "database reopen" in
 * `DbManagerTest` just means constructing a new `DbManager` over the same [baseDir]; nothing is
 * held open in memory between instances by design.
 */
class DbManager(private val baseDir: File) {
    init {
        baseDir.mkdirs()
    }

    private val downloadsFile get() = File(baseDir, DOWNLOADS_FILE)
    private val localItemsFile get() = File(baseDir, LOCAL_ITEMS_FILE)

    // ---- Downloads ----

    fun downloads(): List<DownloadItem> {
        if (!downloadsFile.exists()) return emptyList()
        val arr = JSONArray(downloadsFile.readText())
        return (0 until arr.length()).map { downloadItemFromJson(arr.getJSONObject(it)) }
    }

    fun saveDownload(item: DownloadItem) {
        val items = downloads().filterNot { it.id == item.id }.toMutableList()
        items.add(item)
        writeDownloads(items)
    }

    fun removeDownload(id: String) {
        writeDownloads(downloads().filterNot { it.id == id })
    }

    private fun writeDownloads(items: List<DownloadItem>) {
        val arr = JSONArray()
        items.forEach { arr.put(downloadItemToJson(it)) }
        downloadsFile.writeText(arr.toString())
    }

    // ---- Local library items ----

    fun localItems(): List<LocalLibraryItem> {
        if (!localItemsFile.exists()) return emptyList()
        val arr = JSONArray(localItemsFile.readText())
        return (0 until arr.length()).map { localItemFromJson(arr.getJSONObject(it)) }
    }

    fun localItem(libraryItemId: String): LocalLibraryItem? = localItems().find { it.libraryItemId == libraryItemId }

    fun saveLocalItem(item: LocalLibraryItem) {
        val items = localItems().filterNot { it.libraryItemId == item.libraryItemId }.toMutableList()
        items.add(item)
        writeLocalItems(items)
    }

    fun removeLocalItem(libraryItemId: String) {
        writeLocalItems(localItems().filterNot { it.libraryItemId == libraryItemId })
    }

    private fun writeLocalItems(items: List<LocalLibraryItem>) {
        val arr = JSONArray()
        items.forEach { arr.put(localItemToJson(it)) }
        localItemsFile.writeText(arr.toString())
    }

    /** No-op: file-backed storage has nothing to flush/release beyond the writes already
     * performed by `save*()`, unlike a real DB connection -- kept as an explicit method so a
     * "close, reopen" test round trip reads naturally regardless of the backing storage. */
    fun close() = Unit

    companion object {
        private fun downloadItemToJson(item: DownloadItem): JSONObject {
            val obj = JSONObject()
            obj.put("id", item.id)
            obj.put("libraryItemId", item.libraryItemId)
            obj.put("title", item.title)
            obj.put("serverConnectionId", item.serverConnectionId)
            obj.put("serverUrl", item.serverUrl)
            obj.put("bytesDownloaded", item.bytesDownloaded)
            obj.put("totalBytes", item.totalBytes)
            obj.put("state", item.state)
            obj.put("error", item.error)
            obj.put("terminalFailureAt", item.terminalFailureAt)
            val parts = JSONArray()
            item.parts.forEach { parts.put(downloadItemPartToJson(it)) }
            obj.put("parts", parts)
            return obj
        }

        private fun downloadItemFromJson(obj: JSONObject): DownloadItem {
            val partsArr = obj.optJSONArray("parts") ?: JSONArray()
            val parts = (0 until partsArr.length()).map { downloadItemPartFromJson(partsArr.getJSONObject(it)) }.toMutableList()
            return DownloadItem(
                id = obj.getString("id"),
                libraryItemId = obj.getString("libraryItemId"),
                title = obj.getString("title"),
                serverConnectionId = obj.getString("serverConnectionId"),
                serverUrl = obj.optString("serverUrl", ""),
                bytesDownloaded = obj.getLong("bytesDownloaded"),
                totalBytes = obj.getLong("totalBytes"),
                state = obj.getString("state"),
                error = if (obj.isNull("error")) null else obj.getString("error"),
                terminalFailureAt = if (obj.isNull("terminalFailureAt") || !obj.has("terminalFailureAt")) null else obj.getLong("terminalFailureAt"),
                parts = parts
            )
        }

        private fun downloadItemPartToJson(part: DownloadItemPart): JSONObject {
            val obj = JSONObject()
            obj.put("id", part.id)
            obj.put("downloadItemId", part.downloadItemId)
            obj.put("trackIndex", part.trackIndex)
            obj.put("filename", part.filename)
            obj.put("serverPath", part.serverPath)
            obj.put("finalDestinationPath", part.finalDestinationPath)
            obj.put("stagingPath", part.stagingPath)
            obj.put("bytesDownloaded", part.bytesDownloaded)
            obj.put("completed", part.completed)
            obj.put("failed", part.failed)
            obj.put("contentLength", part.contentLength)
            obj.put("state", part.state)
            obj.put("retryCount", part.retryCount)
            return obj
        }

        private fun downloadItemPartFromJson(obj: JSONObject): DownloadItemPart = DownloadItemPart(
            id = obj.getString("id"),
            downloadItemId = obj.getString("downloadItemId"),
            trackIndex = obj.getInt("trackIndex"),
            filename = obj.getString("filename"),
            serverPath = obj.getString("serverPath"),
            finalDestinationPath = obj.getString("finalDestinationPath"),
            stagingPath = obj.optString("stagingPath", "${obj.getString("finalDestinationPath")}.part"),
            bytesDownloaded = obj.getLong("bytesDownloaded"),
            completed = obj.getBoolean("completed"),
            failed = obj.getBoolean("failed"),
            contentLength = if (obj.has("contentLength")) obj.getLong("contentLength") else -1,
            state = obj.optString("state", "queued"),
            retryCount = obj.optInt("retryCount", 0)
        )

        private fun localItemToJson(item: LocalLibraryItem): JSONObject {
            val obj = JSONObject()
            obj.put("libraryItemId", item.libraryItemId)
            obj.put("serverConnectionId", item.serverConnectionId)
            obj.put("folderUri", item.folderUri)
            obj.put("manifestJson", item.manifestJson)
            obj.put("completedAt", item.completedAt)
            return obj
        }

        private fun localItemFromJson(obj: JSONObject): LocalLibraryItem = LocalLibraryItem(
            libraryItemId = obj.getString("libraryItemId"),
            serverConnectionId = obj.getString("serverConnectionId"),
            folderUri = obj.getString("folderUri"),
            manifestJson = obj.getString("manifestJson"),
            completedAt = obj.getLong("completedAt")
        )
    }
}
