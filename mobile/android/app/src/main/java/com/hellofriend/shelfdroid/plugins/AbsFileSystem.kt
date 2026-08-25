package com.hellofriend.shelfdroid.plugins

import android.app.Activity
import android.content.Intent
import android.net.Uri
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import com.hellofriend.shelfdroid.data.LocalLibraryItem
import com.hellofriend.shelfdroid.managers.DbManager
import java.io.File

/**
 * Capacitor bridge implementing the exact TS-side contract
 * `mobile/src/native/absFileSystemPlugin.ts` defines (WI-1496 t800 Task 1):
 * listLocalItems/chooseDownloadFolder/deleteLocalItem. Adapted (not ported verbatim) from the
 * donor app's `plugins/AbsFileSystem.kt`: this milestone drops the `com.anggrayudi.storage`
 * (SimpleStorage) third-party dependency entirely -- `chooseDownloadFolder` uses the plain
 * `androidx.documentfile`/`Intent.ACTION_OPEN_DOCUMENT_TREE` SAF APIs directly, since the donor
 * lib's only real value here (a folder-picker convenience wrapper) isn't worth a new dependency
 * for one call site.
 */
@CapacitorPlugin(name = "AbsFileSystem")
class AbsFileSystem : Plugin() {
    private val dbManager: DbManager get() = DbManager(File(context.filesDir, "shelfdroid_db"))

    @PluginMethod
    fun listLocalItems(call: PluginCall) {
        val items = dbManager.localItems()
        val arr = JSArray()
        items.forEach { arr.put(localItemJs(it)) }
        val result = JSObject()
        result.put("items", arr)
        call.resolve(result)
    }

    @PluginMethod
    fun deleteLocalItem(call: PluginCall) {
        val libraryItemId = call.getString("libraryItemId") ?: return call.reject("Missing 'libraryItemId'")
        val item = dbManager.localItem(libraryItemId)
        if (item != null) {
            // Internal-storage items only for this milestone (SAF folder deletion needs a
            // DocumentFile.fromTreeUri round trip -- deferred to Task 3, which owns the actual
            // download/removal transfer lifecycle this call would otherwise duplicate).
            if (!item.folderUri.startsWith("content://")) {
                File(item.folderUri).deleteRecursively()
            }
        }
        dbManager.removeLocalItem(libraryItemId)
        call.resolve()
    }

    /**
     * Launches the OS SAF folder picker and persists a read/write URI permission grant on the
     * chosen tree before resolving -- required so the app can still write into that folder after
     * process death, per the plan's "SAF destinations persist URI permission before queueing"
     * instruction. Untested on this machine (no device/emulator, same class of gap as t700 Tasks
     * 2-4): the `ActivityCallback` round trip only executes with a real Activity result.
     */
    @PluginMethod
    fun chooseDownloadFolder(call: PluginCall) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        startActivityForResult(call, intent, "chooseDownloadFolderResult")
    }

    /** `mobile/src/native/absFileSystemPlugin.ts`'s `Promise<{ folderUri: string } | null>`
     * return type is realized here as an always-resolved JSObject with `folderUri` either a
     * string or JS `null` -- Capacitor's bridge can't marshal a bare top-level `null` through
     * `PluginCall.resolve`, so a cancelled picker resolves `{ folderUri: null }` rather than
     * rejecting; only a genuine platform/activity error rejects. */
    @ActivityCallback
    private fun chooseDownloadFolderResult(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        val uri = if (result.resultCode == Activity.RESULT_OK) result.data?.data else null
        if (uri == null) {
            call.resolve(JSObject().put("folderUri", null))
            return
        }
        persistFolderPermission(uri)
        call.resolve(JSObject().put("folderUri", uri.toString()))
    }

    private fun persistFolderPermission(uri: Uri) {
        context.contentResolver.takePersistableUriPermission(
            uri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        )
    }

    private fun localItemJs(item: LocalLibraryItem): JSObject {
        val obj = JSObject()
        obj.put("libraryItemId", item.libraryItemId)
        obj.put("serverConnectionId", item.serverConnectionId)
        obj.put("folderUri", item.folderUri)
        obj.put("manifestJson", item.manifestJson)
        obj.put("completedAt", item.completedAt)
        return obj
    }
}
