package com.hellofriend.shelfdroid.models

/**
 * Minimal native download-queue row (WI-1496 t800 Task 2, extended Task 3), adapted from the
 * donor app's `models/DownloadItem.kt` down to exactly what `DbManager` needs to persist and
 * what the Task 1 TS bridge (`mobile/src/downloads/downloadTypes.ts`'s `DownloadSnapshot`) needs
 * to report. Deliberately strips the donor's SAF-permission/media-type/podcast-episode fields --
 * this milestone's local storage is internal-app-storage by default (see
 * `FolderScanner.finalInternalPath`), so `parts` doesn't need per-part SAF URIs yet either.
 *
 * Task 3 additions: [serverUrl] (so `DownloadItemManager` can resolve each part's relative
 * `serverPath` into an absolute URL the same way `PlayerNotificationService.resolveTrackUrl`
 * does for streaming) and [terminalFailureAt] (drives `IncompleteDownloadCleanup`'s retention
 * sweep). No access token is ever a field here -- see the Task 3 dispatch's "no tokens/secrets
 * in persisted state" constraint; `DownloadItemManager` takes a `tokenProvider` callback instead.
 */
data class DownloadItem(
    val id: String,
    val libraryItemId: String,
    val title: String,
    val serverConnectionId: String,
    var serverUrl: String = "",
    var bytesDownloaded: Long = 0,
    var totalBytes: Long = 0,
    var state: String = "queued",
    var error: String? = null,
    var terminalFailureAt: Long? = null,
    val parts: MutableList<DownloadItemPart> = mutableListOf()
)
