package com.hellofriend.shelfdroid.models

/**
 * One audio track's download-part row within a [DownloadItem] (WI-1496 t800 Task 2, extended
 * Task 3), adapted from the donor app's `models/DownloadItemPart.kt` down to the fields needed
 * to resume a transfer and to confirm the file landed at (or is missing from) its confined final
 * path -- see `FolderScanner.finalInternalPath`/`isPartFileMissing`.
 *
 * Task 3 additions: [stagingPath] (the `.part` file `InternalDownloadManager` streams into,
 * distinct from [finalDestinationPath] which only exists once the transfer completes and is
 * renamed into place -- see the plan's "download into `download-staging/{itemId}` using `.part`
 * files ... rename into the final item folder" step), [contentLength] (the expected final byte
 * count; `-1` means unknown until the first response headers arrive), [state] (the full
 * lifecycle vocabulary `DownloadItemManager` drives a part through --
 * queued/running/paused/waiting_for_network/waiting_for_space/complete/failed -- mirroring the
 * TS `DownloadState` union in `downloadTypes.ts`), and [retryCount].
 */
data class DownloadItemPart(
    val id: String,
    val downloadItemId: String,
    val trackIndex: Int,
    val filename: String,
    val serverPath: String,
    val finalDestinationPath: String,
    val stagingPath: String = "$finalDestinationPath.part",
    var bytesDownloaded: Long = 0,
    var completed: Boolean = false,
    var failed: Boolean = false,
    var contentLength: Long = -1,
    var state: String = "queued",
    var retryCount: Int = 0
)
