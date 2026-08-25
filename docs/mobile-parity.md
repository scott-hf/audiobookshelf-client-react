# ShelfDroid / official audiobookshelf-mobile feature parity

WI-1496 t900 Task 5. Audited against the donor tree at
`G:\tools\ABS\claude-audiobookshelf-mobile-acquisition-handoff\reference\audiobookshelf-mobile`
(read-only reference; no code copied for this task) -- specifically
`pages/settings.vue`, `ios/App/Shared/models/DeviceSettings.swift`, and
`ios/App/Shared/models/PlayerSettings.swift` for the settings inventory, plus
this session's own player/downloads/Android-Auto/widget/Cast/deep-link work
(t700-t900) for the rest of the app surface.

Every row carries one of exactly three dispositions: `implemented`,
`not applicable`, or `deferred after v1`.

## Playback settings

| Feature | Status | Notes / destination |
| --- | --- | --- |
| Jump back seconds | implemented | `mobile/src/settings/settingsTypes.ts` `jumpBackSeconds`, `SettingsPage.tsx` |
| Jump forward seconds | implemented | `jumpForwardSeconds`, `SettingsPage.tsx` |
| Default playback rate | implemented | `playbackRate`, `SettingsPage.tsx`; native `AbsAudioPlayerPlugin.setRate` already exists from t700 |
| Disable auto-rewind on resume | deferred after v1 | Not yet surfaced as a preference; no destination finding filed yet -- follow-up needed |
| Allow seeking on media controls (lock-screen/notification) | deferred after v1 | No destination finding filed yet -- follow-up needed |
| MP3 index seeking toggle | not applicable | ExoPlayer (native player, t700) handles MP3 seeking accuracy directly; the donor's toggle exists only for its own web-audio/AVPlayer seeking workaround |
| Bookshelf/alt grid view toggle | not applicable | ShelfDroid's `LibraryPage`/`LibrariesPage` ship one list-based layout; no skeuomorphic bookshelf view exists to toggle |
| Orientation lock | deferred after v1 | No destination finding filed yet -- follow-up needed |
| Haptic feedback level | deferred after v1 | No destination finding filed yet -- follow-up needed |
| Language / locale selection | not applicable | Single-locale (en) build; no i18n infrastructure in this stack yet |
| Chapter track toggle (iOS `PlayerSettings.chapterTrack`) | deferred after v1 | No destination finding filed yet -- follow-up needed |

## Sleep timer

| Feature | Status | Notes / destination |
| --- | --- | --- |
| Sleep timer default duration | implemented | `sleepTimerDefaultMs`, `SettingsPage.tsx` (native `AbsAudioPlayerPlugin.setSleepTimer` already exists from t700) |
| Shake-to-reset sleep timer + sensitivity | deferred after v1 | No destination finding filed yet -- follow-up needed |
| Auto sleep timer schedule (start/end time) | deferred after v1 | No destination finding filed yet -- follow-up needed |
| Sleep timer fade-out | deferred after v1 | No destination finding filed yet -- follow-up needed |
| Sleep timer reset vibration feedback | deferred after v1 | No destination finding filed yet -- follow-up needed |
| Sleep timer "almost done" chime | deferred after v1 | No destination finding filed yet -- follow-up needed |

## Downloads / data usage

| Feature | Status | Notes / destination |
| --- | --- | --- |
| Wi-Fi-only downloads | implemented | `wifiOnly`, `SettingsPage.tsx` -- gateway/native download enqueue enforcement is a separate wiring step, not yet connected to this preference (see below) |
| Enforcing `wifiOnly` at download-enqueue time | deferred after v1 | `DownloadProvider.download()` (t800) does not yet read `MobileSettings.wifiOnly` before enqueueing -- no destination finding filed yet |
| Streaming-over-cellular restriction | not applicable | ShelfDroid always streams over whatever connection is active; the donor's separate `streamingUsingCellular` ask/always/never prompt has no ShelfDroid equivalent UI yet, and blocking playback on connection type is out of scope for this stack |
| Download destination: internal app storage | implemented | `downloadDestination: 'internal'`, `SettingsPage.tsx` |
| Download destination: SAF (choose folder) | deferred after v1 | `SettingsPage.tsx` invokes `AbsFileSystemNative.chooseDownloadFolder()` on selection, but the resulting folder URI is not yet persisted into `MobileSettings` or read back by the downloader (t800's `AbsDownloader.kt` always uses its own internal path) -- no destination finding filed yet |
| Local storage usage display | implemented | `SettingsPage.tsx` sums `bytesDownloaded` across `complete` entries in the download queue; this is downloaded-audio-bytes only, not full on-disk usage (covers/manifests not measured) |
| Offline downloads (audio tracks) | implemented | t800 (`DownloadProvider`, `AbsDownloader.kt`) |
| Offline downloads: cover art / ebook files | deferred after v1 | FND-00465 |

## Connection / account management

| Feature | Status | Notes / destination |
| --- | --- | --- |
| Single-server login/logout | implemented | `SettingsPage.tsx` Connection section (`useAuth().logout`), `auth/AuthProvider.tsx`/`auth/session.ts` |
| Multi-server / multi-account switching | not applicable | This stack's `SessionVault` (`native/secureSession.ts`) persists exactly one active session by design (t600) -- no multi-account concept exists anywhere in the auth layer to switch between |
| Log export | deferred after v1 | `SettingsPage.tsx` ships an "Export logs" control that never throws, but there is no native log-capture surface behind it yet -- no destination finding filed yet |

## Android Auto

| Feature | Status | Notes / destination |
| --- | --- | --- |
| Browse tree (libraries/items) | implemented | t900 Task 1 (`BrowseTree.kt`, `MediaSessionPlaybackPreparer.kt`) |
| Connectable `MediaBrowserServiceCompat` host | deferred after v1 | FND-00466 |
| Browse-grouping limit / series sequence order preferences | deferred after v1 | Depends on the above; no destination finding filed yet |

## Chromecast

| Feature | Status | Notes / destination |
| --- | --- | --- |
| Cast handoff (single audio track) | implemented | t900 Task 3 (`castHandoff.ts`, `CastManager.kt`/`CastPlayer.kt`/`CastTimeline.kt`) |
| Multi-track cast sessions | deferred after v1 | FND-00467 |
| Casting offline-downloaded items | deferred after v1 | FND-00467 |

## Home screen

| Feature | Status | Notes / destination |
| --- | --- | --- |
| Home-screen player widget | implemented | t900 Task 2 (`MediaPlayerWidget.kt`) |

## Deep links / intents

| Feature | Status | Notes / destination |
| --- | --- | --- |
| Verified HTTPS App Links (`books.example.com/library/...`) | implemented | t900 Task 4 (`deepLinks.ts`, `AndroidManifest.xml`, `deploy/acquisition/assetlinks.json.example`) |
| Custom `shelfdroid://` scheme links | implemented | t900 Task 4 |
| Queueing links until authentication is restored | implemented | t900 Task 4 (`App.tsx` `DeepLinkListener`) |
| On-device deep-link-opening verification | deferred after v1 | No physical device/emulator available this session (same standing constraint as t650) -- unverified by design, not a code gap |

## UI theme

| Feature | Status | Notes / destination |
| --- | --- | --- |
| Theme selection (dark/light/black) | implemented | `theme`, `SettingsPage.tsx` -- selecting a theme currently only persists the preference; it is not yet wired to actually restyle the app (no destination finding filed yet) |
