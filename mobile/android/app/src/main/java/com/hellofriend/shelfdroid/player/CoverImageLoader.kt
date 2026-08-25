package com.hellofriend.shelfdroid.player

import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import android.util.Log
import com.bumptech.glide.Glide
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private const val TAG = "CoverImageLoader"

/** Loads [uri] as a bitmap via Glide, returning null on failure so callers can fall back to a
 * static icon. Adapted from the donor app's `CoverImageLoader.kt`.
 *
 * Not yet wired to a live cover URL: the current `PlaybackSession`/`AbsAudioPlayerLoadOptions`
 * contract (WI-1496 t700 Task 1) carries no cover-art field, so nothing calls this yet -- kept as
 * the ported utility for a later cover-art task to connect to the media-session notification. */
suspend fun resolveUriAsBitmap(context: Context, uri: Uri): Bitmap? = withContext(Dispatchers.IO) {
    try {
        Glide.with(context).asBitmap().load(uri).submit().get()
    } catch (e: Exception) {
        Log.e(TAG, "Failed to load cover bitmap for uri: $uri", e)
        null
    }
}
