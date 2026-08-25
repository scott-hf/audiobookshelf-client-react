package com.hellofriend.shelfdroid.player

/**
 * Resolves an Android Auto media-browser prepare/play request (by media id, or free-text voice
 * search) against a [BrowseTree] (WI-1496 t900 Task 1).
 *
 * Adapted from the donor app's `MediaSessionConnector`-based `MediaSessionPlaybackPreparer.kt` --
 * this repo has neither the `exoplayer-mediasession` extension nor a `MediaBrowserServiceCompat`
 * (out of this task's 6-file scope), so this class does not implement
 * `MediaSessionConnector.PlaybackPreparer`; it is a plain resolver any future
 * `MediaSessionCompat.Callback`/`MediaBrowserServiceCompat` wiring can call into.
 *
 * [PlayerNotificationService] never resolves its own catalog (see that class's doc note: it
 * accepts exactly one already-resolved `PlaybackSession` per `load()` call) -- so a resolved
 * request here is handed to [listener] rather than played directly. The JS side (Capacitor
 * plugin bridge) owns the actual ABS session-resolution + `load()` call, exactly like every
 * other play action; this preparer's job stops at "which already-known/cached mediaId was
 * meant", never acquisition/download-initiation.
 */
fun interface PlaybackRequestListener {
    fun onPlaybackRequested(mediaId: String)
}

class MediaSessionPlaybackPreparer(
    private val browseTree: BrowseTree,
    private val listener: PlaybackRequestListener
) {
    /** @return true if [mediaId] resolved to a playable item and [listener] was notified. */
    fun onPrepareFromMediaId(mediaId: String): Boolean {
        val item = browseTree.item(mediaId) ?: return false
        if (!item.isPlayable) return false
        listener.onPlaybackRequested(item.mediaId)
        return true
    }

    /** Normalizes [query] via [BrowseTree.search] and prepares the best (first) playable match,
     * if any. @return true if a match was found and [listener] was notified. */
    fun onPrepareFromSearch(query: String): Boolean {
        val match = browseTree.search(query).firstOrNull() ?: return false
        listener.onPlaybackRequested(match.mediaId)
        return true
    }
}
