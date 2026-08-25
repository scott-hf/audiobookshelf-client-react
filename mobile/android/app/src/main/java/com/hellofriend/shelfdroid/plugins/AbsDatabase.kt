package com.hellofriend.shelfdroid.plugins

import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.hellofriend.shelfdroid.managers.DbManager
import com.hellofriend.shelfdroid.models.DownloadItem
import java.io.File

/**
 * Capacitor bridge over `DbManager`'s raw download-queue rows (WI-1496 t800 Task 2), adapted
 * from the donor app's much larger `plugins/AbsDatabase.kt` (which also brokers device
 * settings, logs, and playback-session history -- all out of scope for this milestone).
 *
 * DESIGN NOTE (flagged per the dispatch's verification contract, not a blocker): Task 1's TS
 * contract (`mobile/src/downloads/downloadTypes.ts`/`absFileSystemPlugin.ts`) already routes
 * *local library item* reads through `AbsFileSystemPlugin.listLocalItems()`, and *download
 * queue* reads/writes are `AbsDownloaderPlugin.listQueue()` (Task 3, not yet implemented). That
 * leaves no TS-side caller for this plugin in the current milestone -- it exists now only so
 * `DownloadItemManager` (Task 3, native-only) has a `DbManager`-backed queue read/write surface
 * to call into without duplicating `DbManager` construction logic, and so Task 3's `AbsDownloader`
 * plugin can eventually delegate `listQueue()` to `getDownloads()` below rather than re-deriving
 * it. Nothing on the JS side registers/calls `AbsDatabase` yet; if Task 3 lands and doesn't end
 * up needing raw JSON-shaped queue access, this plugin's `@CapacitorPlugin` registration should
 * be reconsidered (an unregistered access class instead) rather than left as unreachable-from-JS
 * surface.
 */
@CapacitorPlugin(name = "AbsDatabase")
class AbsDatabase : Plugin() {
    private val dbManager: DbManager get() = DbManager(File(context.filesDir, "shelfdroid_db"))

    @PluginMethod
    fun getDownloads(call: PluginCall) {
        val arr = JSArray()
        dbManager.downloads().forEach { arr.put(downloadItemJs(it)) }
        val result = JSObject()
        result.put("items", arr)
        call.resolve(result)
    }

    @PluginMethod
    fun removeDownload(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject("Missing 'id'")
        dbManager.removeDownload(id)
        call.resolve()
    }

    private fun downloadItemJs(item: DownloadItem): JSObject {
        val obj = JSObject()
        obj.put("id", item.id)
        obj.put("libraryItemId", item.libraryItemId)
        obj.put("title", item.title)
        obj.put("serverConnectionId", item.serverConnectionId)
        obj.put("bytesDownloaded", item.bytesDownloaded)
        obj.put("totalBytes", item.totalBytes)
        obj.put("state", item.state)
        obj.put("error", item.error)
        return obj
    }
}
