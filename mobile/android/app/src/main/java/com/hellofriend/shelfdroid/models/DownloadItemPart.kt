package com.hellofriend.shelfdroid.models

/**
 * One audio track's download-part row within a [DownloadItem] (WI-1496 t800 Task 2), adapted
 * from the donor app's `models/DownloadItemPart.kt` down to the fields needed to resume a
 * transfer and to confirm the file landed at (or is missing from) its confined final path --
 * see `FolderScanner.finalInternalPath`/`isPartFileMissing`.
 */
data class DownloadItemPart(
    val id: String,
    val downloadItemId: String,
    val trackIndex: Int,
    val filename: String,
    val serverPath: String,
    val finalDestinationPath: String,
    var bytesDownloaded: Long = 0,
    var completed: Boolean = false,
    var failed: Boolean = false
)
