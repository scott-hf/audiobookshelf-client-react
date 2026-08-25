package com.hellofriend.shelfdroid.data

/** Mirrors the TS `AbsPlaybackSession.audioTracks` shape (mobile/src/types/abs.ts) that the
 * JS side already resolves via `AbsClient.startSession` -- the native plugin receives it
 * pre-resolved through `AbsAudioPlayerLoadOptions.session` (Task 1), never fetches it itself. */
data class AudioTrack(
    val index: Int,
    val contentUrl: String,
    val duration: Double
)

/** Minimal native session model: WI-1496 t700 milestone deliberately strips the donor's
 * database/downloader/local-item/podcast fields (out of scope per the plan's Task 2 stripping
 * instruction) -- only what's needed to build an ExoPlayer media source and report progress. */
data class PlaybackSession(
    val id: String,
    val currentTime: Double,
    val audioTracks: List<AudioTrack>
)
