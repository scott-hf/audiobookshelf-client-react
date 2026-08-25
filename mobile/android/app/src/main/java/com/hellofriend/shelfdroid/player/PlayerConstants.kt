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
