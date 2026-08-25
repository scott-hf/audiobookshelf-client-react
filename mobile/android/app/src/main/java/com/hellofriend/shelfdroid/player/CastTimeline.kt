package com.hellofriend.shelfdroid.player

/**
 * Describes what to load onto a Cast receiver (WI-1496 t900 Task 3). NOT the donor app's
 * `CastTimeline` (a full `com.google.android.exoplayer2.Timeline` SPI implementation backing its
 * locally-forked `CastPlayer`) -- [CastPlaybackController] (`CastPlayer.kt`) delegates
 * timeline/position tracking to the OFFICIAL `extension-cast` artifact's own `CastPlayer`
 * internals instead of reimplementing them (see `CastManager.kt`'s class doc for the full
 * tradeoff). This file holds only the small immutable descriptor `loadMedia` needs, kept as its
 * own file (matching the plan's file list) so a future multi-track/queue Cast timeline (see this
 * task's GAPS note on multi-track sessions not currently handed off) has an obvious place to
 * grow into.
 */
data class CastMediaDescriptor(
    val contentUrl: String,
    val contentType: String,
    val title: String,
    val startPositionMs: Long
)
