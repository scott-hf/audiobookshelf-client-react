# Android Native Playback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace vertical-slice HTML audio with a foreground native player that supports lock-screen controls, headset/Bluetooth events, sleep timer, and process recovery.

**Architecture:** Keep `PlayerProvider` behind the existing `MobilePlayer` interface and add a Capacitor bridge backed by the official app’s proven Kotlin player/service design. Port from pinned donor commit `advplyr/audiobookshelf-app@12025ab59a5c9f5654b31b4b68c1fc71ad676f61`, then adapt package names and the smaller React-facing payload.

**Tech Stack:** Capacitor 7, Kotlin 2, ExoPlayer 2.18.7, AndroidX MediaSession, foreground services, Vitest, JUnit, Espresso

---

## File Map

| Destination | Donor reference or responsibility |
|---|---|
| `mobile/src/player/nativeAudioPlayer.ts` | Typed Capacitor adapter |
| `mobile/android/.../plugins/AbsAudioPlayer.kt` | Donor `plugins/AbsAudioPlayer.kt` |
| `mobile/android/.../player/PlayerNotificationService.kt` | Donor service owner |
| `mobile/android/.../player/MediaSessionCallback.kt` | Media commands |
| `mobile/android/.../player/PlayerListener.kt` | Native-to-React state |
| `mobile/android/.../managers/SleepTimerManager.kt` | Sleep lifecycle |
| `mobile/android/.../data/PlaybackSession.kt` | Minimal native session model |
| `mobile/android/app/src/main/AndroidManifest.xml` | Service and permissions |

### Task 1: Define and test the native player contract

**Files:**
- Modify: `mobile/src/player/playerTypes.ts`
- Create: `mobile/src/player/nativeAudioPlayer.ts`
- Create: `mobile/src/native/absAudioPlayerPlugin.ts`
- Test: `mobile/src/player/nativeAudioPlayer.test.ts`

- [ ] **Step 1: Write the failing adapter test**

```ts
it('translates native events into the stable MobilePlayer contract', async () => {
  const plugin = fakeNativePlugin()
  const player = createNativeAudioPlayer(plugin)
  const states: PlayerSnapshot[] = []
  player.subscribe((state) => states.push(state))
  await player.load(sessionFixture)
  plugin.emit('playerState', { state: 'playing', currentTime: 42, duration: 3600, playbackRate: 1.25 })
  expect(states.at(-1)).toMatchObject({ status: 'playing', currentTime: 42, duration: 3600, rate: 1.25 })
})
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm --filter @abs/mobile test -- src/player/nativeAudioPlayer.test.ts
```

Expected: FAIL because the native adapter is missing.

- [ ] **Step 3: Define the bridge**

```ts
export interface AbsAudioPlayerPlugin {
  load(options: { session: PlaybackSession; accessToken: string; serverUrl: string }): Promise<void>
  play(): Promise<void>
  pause(): Promise<void>
  seek(options: { seconds: number }): Promise<void>
  setRate(options: { rate: number }): Promise<void>
  stop(): Promise<void>
  setSleepTimer(options: { seconds: number | null }): Promise<void>
  getState(): Promise<PlayerSnapshot>
  addListener(event: 'playerState', listener: (state: NativePlayerState) => void): Promise<PluginListenerHandle>
}
```

Map `buffering`, `playing`, `paused`, `ended`, and `error` into `PlayerSnapshot`; clamp position to `0..duration`.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @abs/mobile test -- src/player/nativeAudioPlayer.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/player mobile/src/native
git commit -m "feat: define native mobile player contract"
```

### Task 2: Port the foreground service and media session

**Files:**
- Create: `mobile/android/app/src/main/java/com/hellofriend/shelfdroid/plugins/AbsAudioPlayer.kt`
- Create: `mobile/android/app/src/main/java/com/hellofriend/shelfdroid/player/PlayerNotificationService.kt`
- Create: `mobile/android/app/src/main/java/com/hellofriend/shelfdroid/player/MediaSessionCallback.kt`
- Create: `mobile/android/app/src/main/java/com/hellofriend/shelfdroid/player/PlayerListener.kt`
- Create: `mobile/android/app/src/main/java/com/hellofriend/shelfdroid/player/PlayerNotificationListener.kt`
- Create: `mobile/android/app/src/main/java/com/hellofriend/shelfdroid/player/CoverImageLoader.kt`
- Create: `mobile/android/app/src/main/java/com/hellofriend/shelfdroid/data/PlaybackSession.kt`
- Modify: `mobile/android/app/src/main/java/com/hellofriend/shelfdroid/MainActivity.kt`
- Modify: `mobile/android/app/src/main/AndroidManifest.xml`
- Modify: `mobile/android/app/build.gradle`
- Test: `mobile/android/app/src/test/java/com/hellofriend/shelfdroid/player/PlayerStateReducerTest.kt`

- [ ] **Step 1: Add the failing native state test**

```kotlin
@Test fun endedStateStopsForegroundAndEmitsFinalPosition() {
  val reducer = PlayerStateReducer()
  val result = reducer.reduce(PlayerEvent.Ended(positionMs = 3_600_000))
  assertEquals(PlayerStatus.ENDED, result.snapshot.status)
  assertTrue(result.stopForeground)
  assertTrue(result.syncFinalProgress)
}
```

- [ ] **Step 2: Run and confirm failure**

```bash
./mobile/android/gradlew -p mobile/android testDebugUnitTest --tests '*PlayerStateReducerTest'
```

Expected: FAIL because the Kotlin player layer is absent.

- [ ] **Step 3: Port and adapt the donor files**

Use the pinned donor files named in the file map. Change packages from `com.audiobookshelf.app` to `com.hellofriend.shelfdroid`. Remove database, downloader, Cast, widget, and browse-tree dependencies from this milestone. Accept the playback session JSON from the plugin call, construct a `ConcatenatingMediaSource` from session tracks, and attach bearer auth through the HTTP data source.

Register:

```kotlin
registerPlugin(AbsAudioPlayer::class.java)
```

Declare:

```xml
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />
<service
    android:name=".player.PlayerNotificationService"
    android:exported="false"
    android:foregroundServiceType="mediaPlayback" />
<receiver android:name="androidx.media.session.MediaButtonReceiver" android:exported="true">
  <intent-filter><action android:name="android.intent.action.MEDIA_BUTTON" /></intent-filter>
</receiver>
```

- [ ] **Step 4: Run native unit tests and assemble**

```bash
./mobile/android/gradlew -p mobile/android testDebugUnitTest assembleDebug
```

Expected: PASS; APK contains `PlayerNotificationService` and starts playback with the Activity backgrounded.

- [ ] **Step 5: Commit**

```bash
git add mobile/android/app/src/main mobile/android/app/src/test mobile/android/app/build.gradle
git commit -m "feat: port native Audiobookshelf playback service"
```

### Task 3: Add controls, sleep timer, and progress ownership

**Files:**
- Create: `mobile/android/app/src/main/java/com/hellofriend/shelfdroid/managers/SleepTimerManager.kt`
- Create: `mobile/android/app/src/main/java/com/hellofriend/shelfdroid/player/PlayerConstants.kt`
- Modify: `mobile/android/app/src/main/java/com/hellofriend/shelfdroid/plugins/AbsAudioPlayer.kt`
- Modify: `mobile/src/player/PlayerProvider.tsx`
- Modify: `mobile/src/routes/PlayerPage.tsx`
- Test: `mobile/android/app/src/test/java/com/hellofriend/shelfdroid/managers/SleepTimerManagerTest.kt`
- Test: `mobile/src/player/nativeProgressSync.test.ts`

- [ ] **Step 1: Write failing sleep/progress tests**

```kotlin
@Test fun timerPausesAtDeadlineAndCanBeExtended() {
  val timer = SleepTimerManager(clock)
  timer.start(600)
  clock.advanceSeconds(300)
  timer.addSeconds(300)
  clock.advanceSeconds(599)
  assertFalse(timer.expired())
  clock.advanceSeconds(1)
  assertTrue(timer.expired())
}
```

- [ ] **Step 2: Run and confirm failure**

```bash
./mobile/android/gradlew -p mobile/android testDebugUnitTest --tests '*SleepTimerManagerTest'
pnpm --filter @abs/mobile test -- src/player/nativeProgressSync.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement native controls**

Support play/pause, seek, previous/next chapter, configurable jump forward/back, playback rate, headset/Bluetooth media buttons, audio focus loss/gain, noisy-output pause, and timer start/cancel/extend. Keep ABS session start/sync/close in React; native events supply authoritative position and play state.

```ts
useEffect(() => player.subscribe((snapshot) => {
  setSnapshot(snapshot)
  progressSync.observe(snapshot)
}), [player, progressSync])
```

- [ ] **Step 4: Run player test suites**

```bash
pnpm --filter @abs/mobile test -- src/player
./mobile/android/gradlew -p mobile/android testDebugUnitTest
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/player mobile/src/routes/PlayerPage.tsx mobile/android/app/src/main/java/com/hellofriend/shelfdroid/managers mobile/android/app/src/main/java/com/hellofriend/shelfdroid/player mobile/android/app/src/test
git commit -m "feat: add native playback controls and sleep timer"
```

### Task 4: Recover playback across lifecycle events

**Files:**
- Create: `mobile/android/app/src/main/java/com/hellofriend/shelfdroid/player/PlaybackStateStore.kt`
- Modify: `mobile/android/app/src/main/java/com/hellofriend/shelfdroid/player/PlayerNotificationService.kt`
- Modify: `mobile/android/app/src/main/java/com/hellofriend/shelfdroid/plugins/AbsAudioPlayer.kt`
- Modify: `mobile/src/player/PlayerProvider.tsx`
- Test: `mobile/android/app/src/androidTest/java/com/hellofriend/shelfdroid/player/PlaybackRecoveryTest.kt`

- [ ] **Step 1: Write the failing recovery test**

```kotlin
@Test fun serviceRestoresPausedSessionAfterActivityRecreation() {
  launchAndLoadSession("session-1", positionMs = 42_000)
  recreateActivity()
  val state = audioPlayerPlugin().getState()
  assertEquals("session-1", state.sessionId)
  assertEquals(42_000, state.positionMs)
  assertEquals("paused", state.status)
}
```

- [ ] **Step 2: Run and confirm failure**

```bash
./mobile/android/gradlew -p mobile/android connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.hellofriend.shelfdroid.player.PlaybackRecoveryTest
```

Expected: FAIL because state restoration is absent.

- [ ] **Step 3: Persist minimal recovery state**

Persist session ID, item ID, serialized tracks, position, rate, paused/playing intent, server URL fingerprint, and update timestamp. Never persist the access token in player state; request the current token from `SecureSessionPlugin` when restoring.

```kotlin
data class StoredPlaybackState(
  val sessionId: String,
  val libraryItemId: String,
  val sessionJson: String,
  val positionMs: Long,
  val rate: Float,
  val shouldResume: Boolean,
  val updatedAt: Long
)
```

- [ ] **Step 4: Run the native playback release gate**

```bash
pnpm --filter @abs/mobile test
./mobile/android/gradlew -p mobile/android testDebugUnitTest connectedDebugAndroidTest assembleDebug
```

Expected: playback survives rotation, Activity recreation, screen lock, Bluetooth disconnect, and background/foreground transitions; process restart restores a paused recoverable session.

- [ ] **Step 5: Commit**

```bash
git add mobile/android/app/src/main/java/com/hellofriend/shelfdroid/player mobile/android/app/src/androidTest mobile/src/player
git commit -m "feat: recover native playback state"
```
