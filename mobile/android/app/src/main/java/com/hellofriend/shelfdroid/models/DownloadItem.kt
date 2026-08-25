package com.hellofriend.shelfdroid.models

/**
 * Minimal native download-queue row (WI-1496 t800 Task 2), adapted from the donor app's
 * `models/DownloadItem.kt` down to exactly what `DbManager` needs to persist and what the
 * Task 1 TS bridge (`mobile/src/downloads/downloadTypes.ts`'s `DownloadSnapshot`) needs to
 * report. Deliberately strips the donor's SAF-permission/media-type/podcast-episode fields --
 * DownloadItemManager (Task 3) owns actual transfer state; this milestone's local storage is
 * internal-app-storage by default (see `FolderScanner.finalInternalPath`), so `parts` doesn't
 * need per-part SAF URIs yet either.
 */
data class DownloadItem(
    val id: String,
    val libraryItemId: String,
    val title: String,
    val serverConnectionId: String,
    val bytesDownloaded: Long,
    val totalBytes: Long,
    val state: String,
    val error: String? = null,
    val parts: MutableList<DownloadItemPart> = mutableListOf()
)
