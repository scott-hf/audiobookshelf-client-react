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
    /** Best-effort presentation metadata captured at enqueue time and copied into the manifest so
     * a downloaded book is presentable offline. None of it gates the audio download. */
    var author: String? = null,
    var narrator: String? = null,
    /** Total duration in seconds; `0` when unknown. */
    var duration: Double = 0.0,
    /** Server-relative (or absolute) cover URL to fetch once the audio is complete; null/blank = none. */
    var coverServerPath: String? = null,
    /** Absolute path of the locally stored cover, set only after it was downloaded successfully. */
    var coverPath: String? = null,
    /** Chapter list as a JSON array string (`[{id,start,end,title}]`); null when unknown. */
    var chaptersJson: String? = null,
    val parts: MutableList<DownloadItemPart> = mutableListOf()
)
