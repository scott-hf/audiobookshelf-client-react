package com.hellofriend.shelfdroid.player

const val NOTIFICATION_CHANNEL_ID = "com.hellofriend.shelfdroid.PLAYBACK_CHANNEL"
const val NOTIFICATION_CHANNEL_NAME = "Audiobook Playback"
const val NOTIFICATION_ID = 10

const val CUSTOM_ACTION_JUMP_FORWARD = "com.hellofriend.shelfdroid.customAction.jump_forward"
const val CUSTOM_ACTION_JUMP_BACKWARD = "com.hellofriend.shelfdroid.customAction.jump_backward"

// Fixed jump amounts for this milestone; the donor app makes these user-configurable device
// settings, which is out of scope until a later parity task.
const val JUMP_FORWARD_MS = 30_000L
const val JUMP_BACKWARD_MS = 10_000L

// WI-1496 t800 Task 5: URI schemes `resolveTrackUrl` passes through untouched instead of
// prefixing with `serverUrl` -- `http(s)://` (the pre-existing streaming case) plus the local
// downloader's `file://`/`content://` offline-playback URIs (see `offlineSource.ts`'s
// `toLocalUri`).
val LOCAL_URI_SCHEMES = listOf("http://", "https://", "file://", "content://")

// Position ticker: ExoPlayer only reports state *changes*, so while playing/buffering the service
// re-emits the snapshot on this period to keep the JS-side position (and jump-relative seeks) live.
const val POSITION_TICK_MS = 500L

// Throttle for persisting the recovery snapshot from ticks (state-change events persist
// immediately; ticks only need to keep the saved position reasonably fresh).
const val TICK_PERSIST_INTERVAL_MS = 5_000L

// Stall watchdog: network timeouts and retry budget for streaming. The ExoPlayer defaults (8s
// connect/read, 3 retries for non-live progressive) leave a dead connection buffering for a long
// time with no way for the UI to tell; these fail fast enough that the error/retry path engages.
const val HTTP_CONNECT_TIMEOUT_MS = 10_000
const val HTTP_READ_TIMEOUT_MS = 15_000
const val LOAD_RETRY_COUNT = 4

// DefaultLoadControl buffer windows (ms): enough headroom for long-form speech without holding
// minutes of audio in memory, and a short re-buffer threshold so playback resumes quickly after a stall.
const val MIN_BUFFER_MS = 30_000
const val MAX_BUFFER_MS = 120_000
const val BUFFER_FOR_PLAYBACK_MS = 1_500
const val BUFFER_FOR_PLAYBACK_AFTER_REBUFFER_MS = 3_000

// How long the service stays in the foreground after `stop(keepForeground = true)` (an item
// replacement) waiting for the follow-up `load()`. Longer than the JS loading watchdog (30 s) plus
// session-start time, so a slow-but-healthy replacement never loses its foreground status; if the
// load never arrives (session request failed, WebView died) the service releases it instead of
// leaving an idle foreground notification up indefinitely.
const val FOREGROUND_HANDOVER_TIMEOUT_MS = 60_000L
