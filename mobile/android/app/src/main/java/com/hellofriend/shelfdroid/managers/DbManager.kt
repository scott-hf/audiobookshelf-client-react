package com.hellofriend.shelfdroid.managers

import com.hellofriend.shelfdroid.data.LocalLibraryItem
import com.hellofriend.shelfdroid.models.DownloadItem
import com.hellofriend.shelfdroid.models.DownloadItemPart
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONException
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.concurrent.ConcurrentHashMap
import java.util.logging.Level
import java.util.logging.Logger

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

    // Every read and every read-modify-write goes through this per-directory lock. It is keyed on
    // the canonical `baseDir` (not the instance) so two `DbManager`s over the same directory --
    // the "reopen" pattern, or the plugin layer and the foreground service -- still serialize
    // against each other inside one process.
    private val lock: Any = lockFor(baseDir)

    // ---- Downloads ----

    fun downloads(): List<DownloadItem> = synchronized(lock) {
        readEntries(downloadsFile, strict = false, parse = { downloadItemFromJson(it) })
    }

    fun saveDownload(item: DownloadItem) = synchronized(lock) {
        val items = readEntries(downloadsFile, strict = true, parse = { downloadItemFromJson(it) }).filterNot { it.id == item.id }.toMutableList()
        items.add(item)
        writeDownloads(items)
    }

    fun removeDownload(id: String) = synchronized(lock) {
        writeDownloads(readEntries(downloadsFile, strict = true, parse = { downloadItemFromJson(it) }).filterNot { it.id == id })
    }

    private fun writeDownloads(items: List<DownloadItem>) {
        val arr = JSONArray()
        items.forEach { arr.put(downloadItemToJson(it)) }
        writeAtomically(downloadsFile, arr.toString())
    }

    // ---- Local library items ----

    fun localItems(): List<LocalLibraryItem> = synchronized(lock) {
        readEntries(localItemsFile, strict = false, parse = { localItemFromJson(it) })
    }

    fun localItem(libraryItemId: String): LocalLibraryItem? = localItems().find { it.libraryItemId == libraryItemId }

    fun saveLocalItem(item: LocalLibraryItem) = synchronized(lock) {
        val items = readEntries(localItemsFile, strict = true, parse = { localItemFromJson(it) }).filterNot { it.libraryItemId == item.libraryItemId }.toMutableList()
        items.add(item)
        writeLocalItems(items)
    }

    fun removeLocalItem(libraryItemId: String) = synchronized(lock) {
        writeLocalItems(readEntries(localItemsFile, strict = true, parse = { localItemFromJson(it) }).filterNot { it.libraryItemId == libraryItemId })
    }

    private fun writeLocalItems(items: List<LocalLibraryItem>) {
        val arr = JSONArray()
        items.forEach { arr.put(localItemToJson(it)) }
        writeAtomically(localItemsFile, arr.toString())
    }

    /** Reads one index file. A missing/blank file is empty. A file that does not parse as a JSON
     * array is treated as empty (never thrown out of a startup path): it is first copied to
     * `<name>.corrupt` so the next write cannot destroy the only copy, and the event is logged.
     * An individual malformed row is skipped (and logged) instead of discarding its siblings.
     * With [strict] (read-modify-write callers) a genuine I/O failure is rethrown rather than
     * read as "empty", because writing back an empty list would wipe the whole catalog. */
    private fun <T> readEntries(file: File, strict: Boolean, parse: (JSONObject) -> T): List<T> {
        if (!file.exists()) return emptyList()
        val text = try {
            file.readText(Charsets.UTF_8)
        } catch (e: IOException) {
            if (strict) throw e
            LOG.log(Level.WARNING, "Could not read ${file.name}; treating as empty", e)
            return emptyList()
        }
        if (text.isBlank()) return emptyList()
        val arr = try {
            JSONArray(text)
        } catch (e: JSONException) {
            quarantine(file, e)
            return emptyList()
        }
        val out = ArrayList<T>(arr.length())
        for (i in 0 until arr.length()) {
            try {
                out.add(parse(arr.getJSONObject(i)))
            } catch (e: JSONException) {
                LOG.log(Level.WARNING, "Skipping malformed row $i in ${file.name}", e)
            }
        }
        return out
    }

    private fun quarantine(file: File, cause: Throwable) {
        LOG.log(Level.SEVERE, "${file.name} is corrupt; treating as empty and keeping a copy as ${file.name}.corrupt", cause)
        try {
            file.copyTo(File(file.parentFile, "${file.name}.corrupt"), overwrite = true)
        } catch (e: IOException) {
            LOG.log(Level.WARNING, "Could not preserve corrupt ${file.name}", e)
        }
    }

    /** Writes [content] to `<name>.tmp`, fsyncs, then renames over [target] so a crash or a
     * concurrent reader can only ever observe the old file or the complete new one -- never the
     * truncated-then-partially-written state `File.writeText` leaves behind. */
    private fun writeAtomically(target: File, content: String) {
        val tmp = File(target.parentFile, "${target.name}.tmp")
        try {
            FileOutputStream(tmp).use { out ->
                out.write(content.toByteArray(Charsets.UTF_8))
                out.flush()
                out.fd.sync()
            }
            try {
                Files.move(tmp.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            } catch (e: AtomicMoveNotSupportedException) {
                Files.move(tmp.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING)
            }
        } finally {
            if (tmp.exists()) tmp.delete()
        }
    }

    /** No-op: file-backed storage has nothing to flush/release beyond the writes already
     * performed by `save*()`, unlike a real DB connection -- kept as an explicit method so a
     * "close, reopen" test round trip reads naturally regardless of the backing storage. */
    fun close() = Unit

    companion object {
        private val LOG: Logger = Logger.getLogger("DbManager")
        private val LOCKS = ConcurrentHashMap<String, Any>()

        private fun lockFor(dir: File): Any {
            val key = try { dir.canonicalPath } catch (e: IOException) { dir.absolutePath }
            return LOCKS.getOrPut(key) { Any() }
        }

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
            obj.put("author", item.author)
            obj.put("narrator", item.narrator)
            obj.put("duration", item.duration)
            obj.put("coverServerPath", item.coverServerPath)
            obj.put("coverPath", item.coverPath)
            obj.put("chaptersJson", item.chaptersJson)
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
                author = optStringOrNull(obj, "author"),
                narrator = optStringOrNull(obj, "narrator"),
                duration = obj.optDouble("duration", 0.0).takeIf { it.isFinite() } ?: 0.0,
                coverServerPath = optStringOrNull(obj, "coverServerPath"),
                coverPath = optStringOrNull(obj, "coverPath"),
                chaptersJson = optStringOrNull(obj, "chaptersJson"),
                parts = parts
            )
        }

        private fun optStringOrNull(obj: JSONObject, key: String): String? =
            if (!obj.has(key) || obj.isNull(key)) null else obj.getString(key)

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
            obj.put("duration", part.duration)
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
            retryCount = obj.optInt("retryCount", 0),
            duration = obj.optDouble("duration", 0.0).takeIf { it.isFinite() } ?: 0.0
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
