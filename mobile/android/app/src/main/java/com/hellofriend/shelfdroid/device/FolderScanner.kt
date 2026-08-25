package com.hellofriend.shelfdroid.device

import com.hellofriend.shelfdroid.models.DownloadItemPart
import java.io.File

/** One file found while scanning a completed download's storage location. */
data class ScannedAudioFile(val filename: String, val sizeBytes: Long, val path: String)

/**
 * Filesystem support for the offline downloader (WI-1496 t800 Task 2), adapted from the donor
 * app's `device/FolderScanner.kt` down to the internal-app-storage path this milestone defaults
 * to (per the plan's `finalInternalPath` snippet) -- external/SAF folder scanning needs a real
 * `Context`+`DocumentFile`/`ContentResolver` and is not JVM-unit-testable without Robolectric
 * (not a project dependency); `scanInternalFolder`/`finalInternalPath`/`isPartFileMissing` below
 * are deliberately `Context`-free so `DbManagerTest` can exercise them directly, matching
 * `PlayerStateReducer`'s "testable core, thin Android shell" split. SAF destination scanning is
 * `AbsFileSystem.kt`'s job once it has a bound `Context` (Task 2's plugin layer) -- untested on
 * this machine (no device), same class of gap as t700 Tasks 2-4.
 */
object FolderScanner {
    /** Strips path-traversal and separator characters so a caller-supplied id can never escape
     * the per-item download directory `finalInternalPath` confines it to -- the plan's stripping
     * instruction calls out path confinement as a security-relevant boundary, not just hygiene. */
    fun safeId(raw: String): String = raw.replace(Regex("[^A-Za-z0-9_-]"), "_")

    /** `filesDir/downloads/{serverConnectionId}/{libraryItemId}`, per the plan's Step 3 snippet
     * -- both path segments are sanitized via [safeId] so a malicious/malformed
     * `serverConnectionId`/`libraryItemId` (e.g. containing `../../`) cannot resolve outside the
     * `downloads/` root, regardless of what a compromised or buggy caller passes in. */
    fun finalInternalPath(filesDir: File, connectionId: String, itemId: String): File =
        File(File(File(filesDir, "downloads"), safeId(connectionId)), safeId(itemId))

    /** Lists audio files (by extension) directly inside [dir] -- used both to build a
     * [DownloadItemPart] list for a freshly finished download and, later, to reconcile the
     * catalog against what's actually on disk (a `LocalLibraryItem` whose folder no longer has
     * any of its tracked files is effectively missing, see [isPartFileMissing]). */
    fun scanInternalFolder(dir: File): List<ScannedAudioFile> {
        if (!dir.isDirectory) return emptyList()
        return dir.listFiles { file -> file.isFile && AUDIO_EXTENSIONS.any { file.name.endsWith(it, ignoreCase = true) } }
            ?.map { ScannedAudioFile(filename = it.name, sizeBytes = it.length(), path = it.absolutePath) }
            ?.sortedBy { it.filename }
            ?: emptyList()
    }

    /** True when a completed part's file is absent from disk -- e.g. the user cleared app
     * storage, or external storage was revoked -- so the offline catalog can flag/prune a
     * `LocalLibraryItem` whose files no longer back it up. */
    fun isPartFileMissing(part: DownloadItemPart): Boolean = !File(part.finalDestinationPath).exists()

    private val AUDIO_EXTENSIONS = listOf(".mp3", ".m4a", ".m4b", ".aac", ".flac", ".ogg", ".opus", ".wav")
}
