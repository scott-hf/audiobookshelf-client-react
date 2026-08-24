# Android Extended Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete high-value Android integrations and produce a signed, updateable production release.

**Architecture:** Reuse the native playback service and offline catalog as the single source of media state. Android Auto, the widget, Cast, and deep links become adapters over that state rather than independent players.

**Tech Stack:** AndroidX MediaBrowserService, AppWidget, Google Cast SDK, Android App Links, Capacitor 7, Gradle, GitHub Actions

---

## File Map

| Path | Responsibility |
|---|---|
| `mobile/android/.../player/BrowseTree.kt` | Android Auto hierarchy |
| `mobile/android/.../MediaPlayerWidget.kt` | Home-screen controls |
| `mobile/android/.../player/Cast*.kt` | Cast session and timeline |
| `mobile/src/navigation/deepLinks.ts` | URL-to-route validation |
| `mobile/src/settings/` | Mobile/player/download preferences |
| `mobile/android/app/src/main/res/xml/` | Auto, widget, network, and file metadata |
| `.github/workflows/android-release.yml` | Signed APK/AAB release |

### Task 1: Add Android Auto browsing and voice search

**Files:**
- Create: `mobile/android/app/src/main/java/com/hellofriend/shelfdroid/player/BrowseTree.kt`
- Create: `mobile/android/app/src/main/java/com/hellofriend/shelfdroid/player/MediaSessionPlaybackPreparer.kt`
- Create: `mobile/android/app/src/main/res/xml/automotive_app_desc.xml`
- Modify: `mobile/android/app/src/main/java/com/hellofriend/shelfdroid/player/PlayerNotificationService.kt`
- Modify: `mobile/android/app/src/main/AndroidManifest.xml`
- Test: `mobile/android/app/src/test/java/com/hellofriend/shelfdroid/player/BrowseTreeTest.kt`

- [ ] **Step 1: Write the failing browse-tree test**

```kotlin
@Test fun rootContainsContinueListeningLibrariesAndDownloads() {
  val tree = BrowseTree(repositoryFixture())
  assertEquals(listOf("continue", "libraries", "downloads"), tree.children(BrowseTree.ROOT).map { it.mediaId })
  assertTrue(tree.item("book:b1").isPlayable)
  assertFalse(tree.item("library:lib1").isPlayable)
}
```

- [ ] **Step 2: Run and confirm failure**

```bash
./mobile/android/gradlew -p mobile/android testDebugUnitTest --tests '*BrowseTreeTest'
```

Expected: FAIL because Android Auto browsing is missing.

- [ ] **Step 3: Port and adapt the donor browse layer**

Port `BrowseTree.kt`, `MediaSessionPlaybackPreparer.kt`, and the media-browser service hooks from donor commit `12025ab59a5c9f5654b31b4b68c1fc71ad676f61`. Back them with the local catalog plus cached ABS shelves. Voice search normalizes the query and returns playable item IDs; it never starts acquisition.

```xml
<meta-data android:name="com.google.android.gms.car.application" android:resource="@xml/automotive_app_desc" />
```

- [ ] **Step 4: Run Auto tests and emulator smoke test**

```bash
./mobile/android/gradlew -p mobile/android testDebugUnitTest connectedDebugAndroidTest
```

Expected: Android Auto opens Continue Listening, Libraries, and Downloads; selecting a book starts the existing native player.

- [ ] **Step 5: Commit**

```bash
git add mobile/android/app/src/main/java/com/hellofriend/shelfdroid/player mobile/android/app/src/main/res/xml/automotive_app_desc.xml mobile/android/app/src/main/AndroidManifest.xml mobile/android/app/src/test
git commit -m "feat: add ShelfDroid Android Auto support"
```

### Task 2: Add the home-screen player widget

**Files:**
- Create: `mobile/android/app/src/main/java/com/hellofriend/shelfdroid/MediaPlayerWidget.kt`
- Create: `mobile/android/app/src/main/res/layout/media_player_widget.xml`
- Create: `mobile/android/app/src/main/res/xml/media_player_widget_info.xml`
- Create: `mobile/android/app/src/main/res/drawable-nodpi/media_player_widget_preview.png`
- Modify: `mobile/android/app/src/main/AndroidManifest.xml`
- Modify: `mobile/android/app/src/main/java/com/hellofriend/shelfdroid/player/PlayerNotificationService.kt`
- Test: `mobile/android/app/src/test/java/com/hellofriend/shelfdroid/MediaPlayerWidgetTest.kt`

- [ ] **Step 1: Write the failing command-routing test**

```kotlin
@Test fun widgetButtonsTargetTheExistingPlayerService() {
  assertEquals(PlayerCommand.PLAY_PAUSE, MediaPlayerWidget.commandFor(ACTION_PLAY_PAUSE))
  assertEquals(PlayerCommand.JUMP_BACK, MediaPlayerWidget.commandFor(ACTION_BACK))
  assertEquals(PlayerCommand.JUMP_FORWARD, MediaPlayerWidget.commandFor(ACTION_FORWARD))
}
```

- [ ] **Step 2: Run and confirm failure**

```bash
./mobile/android/gradlew -p mobile/android testDebugUnitTest --tests '*MediaPlayerWidgetTest'
```

Expected: FAIL because the widget is missing.

- [ ] **Step 3: Port the donor widget as a read-only player surface**

Show cover, title, author, play/pause, jump back, and jump forward. Send explicit immutable pending intents to `PlayerNotificationService`; update from the service after state or metadata changes.

```xml
<receiver android:name=".MediaPlayerWidget" android:exported="false">
  <intent-filter><action android:name="android.appwidget.action.APPWIDGET_UPDATE" /></intent-filter>
  <meta-data android:name="android.appwidget.provider" android:resource="@xml/media_player_widget_info" />
</receiver>
```

- [ ] **Step 4: Run widget tests**

```bash
./mobile/android/gradlew -p mobile/android testDebugUnitTest connectedDebugAndroidTest
```

Expected: the widget reflects the active player and every button controls the same session.

- [ ] **Step 5: Commit**

```bash
git add mobile/android/app/src/main/java/com/hellofriend/shelfdroid/MediaPlayerWidget.kt mobile/android/app/src/main/res mobile/android/app/src/main/AndroidManifest.xml mobile/android/app/src/test
git commit -m "feat: add ShelfDroid player widget"
```

### Task 3: Add Chromecast handoff

**Files:**
- Create: `mobile/android/app/src/main/java/com/hellofriend/shelfdroid/CastOptionsProvider.kt`
- Create: `mobile/android/app/src/main/java/com/hellofriend/shelfdroid/player/CastManager.kt`
- Create: `mobile/android/app/src/main/java/com/hellofriend/shelfdroid/player/CastPlayer.kt`
- Create: `mobile/android/app/src/main/java/com/hellofriend/shelfdroid/player/CastTimeline.kt`
- Create: `mobile/src/native/castPlugin.ts`
- Modify: `mobile/src/player/PlayerProvider.tsx`
- Modify: `mobile/android/app/src/main/AndroidManifest.xml`
- Test: `mobile/src/player/castHandoff.test.ts`

- [ ] **Step 1: Write the failing handoff test**

```ts
it('moves position and rate to Cast then resumes native playback on disconnect', async () => {
  native.state.resolves(snapshot({ currentTime: 420, rate: 1.25, status: 'playing' }))
  await controller.connectCast()
  expect(cast.load).toHaveBeenCalledWith(expect.objectContaining({ startTime: 420, rate: 1.25 }))
  cast.emit('disconnected', { currentTime: 600 })
  expect(native.seek).toHaveBeenCalledWith({ seconds: 600 })
})
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm --filter @abs/mobile test -- src/player/castHandoff.test.ts
```

Expected: FAIL because Cast handoff is missing.

- [ ] **Step 3: Port Cast adapters and preserve one ABS session**

Port the donor Cast classes and register the options provider. The React controller pauses native playback, loads the authorized ABS stream into Cast, keeps the same ABS playback session open, syncs Cast position, and resumes native playback at the last Cast position after disconnect.

```xml
<meta-data
  android:name="com.google.android.gms.cast.framework.OPTIONS_PROVIDER_CLASS_NAME"
  android:value="com.hellofriend.shelfdroid.CastOptionsProvider" />
```

- [ ] **Step 4: Run Cast unit and physical-device tests**

```bash
pnpm --filter @abs/mobile test -- src/player/castHandoff.test.ts
./mobile/android/gradlew -p mobile/android testDebugUnitTest assembleDebug
```

Expected: one playback session, monotonic progress, and clean native/Cast handoff.

- [ ] **Step 5: Commit**

```bash
git add mobile/android/app/src/main/java/com/hellofriend/shelfdroid mobile/android/app/src/main/AndroidManifest.xml mobile/src/native/castPlugin.ts mobile/src/player
git commit -m "feat: add Chromecast playback handoff"
```

### Task 4: Add verified deep links and intents

**Files:**
- Create: `mobile/src/navigation/deepLinks.ts`
- Modify: `mobile/src/App.tsx`
- Modify: `mobile/android/app/src/main/AndroidManifest.xml`
- Create: `deploy/acquisition/assetlinks.json.example`
- Test: `mobile/src/navigation/deepLinks.test.ts`

- [ ] **Step 1: Write the failing route validation test**

```ts
it.each([
  ['https://books.example.com/library/lib1/item/abs1', '/library/lib1/item/abs1'],
  ['shelfdroid://library/lib1/discover', '/library/lib1/discover']
])('maps %s', (input, expected) => expect(routeFromDeepLink(input)).toBe(expected))

it('rejects external or traversal links', () => {
  expect(routeFromDeepLink('https://evil.test/library/lib1/item/abs1')).toBeNull()
  expect(routeFromDeepLink('shelfdroid://library/../settings')).toBeNull()
})
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm --filter @abs/mobile test -- src/navigation/deepLinks.test.ts
```

Expected: FAIL because deep-link routing is missing.

- [ ] **Step 3: Register custom and verified HTTPS links**

```xml
<intent-filter android:autoVerify="true">
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data android:scheme="https" android:host="books.example.com" android:pathPrefix="/library/" />
</intent-filter>
<intent-filter>
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data android:scheme="shelfdroid" />
</intent-filter>
```

Validate host, scheme, route segments, and IDs before navigating. Queue links until authentication is restored.

- [ ] **Step 4: Verify links**

```bash
pnpm --filter @abs/mobile test -- src/navigation/deepLinks.test.ts
adb shell am start -a android.intent.action.VIEW -d 'shelfdroid://library/lib1/discover' com.hellofriend.shelfdroid.debug
```

Expected: the debug app opens Discover; invalid hosts remain outside the app.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/navigation mobile/src/App.tsx mobile/android/app/src/main/AndroidManifest.xml deploy/acquisition/assetlinks.json.example
git commit -m "feat: add verified ShelfDroid deep links"
```

### Task 5: Finish settings and parity audit

**Files:**
- Create: `mobile/src/settings/settingsTypes.ts`
- Create: `mobile/src/settings/SettingsProvider.tsx`
- Create: `mobile/src/routes/SettingsPage.tsx`
- Create: `docs/mobile-parity.md`
- Test: `mobile/src/settings/SettingsProvider.test.tsx`

- [ ] **Step 1: Write the failing settings persistence test**

```tsx
it('persists player and download policies without storing credentials', async () => {
  render(<SettingsProvider storage={storage}><SettingsPage /></SettingsProvider>)
  await user.click(screen.getByLabelText('Wi-Fi downloads only'))
  await user.selectOptions(screen.getByLabelText('Jump forward'), '30')
  expect(storage.write).toHaveBeenCalledWith(expect.objectContaining({ wifiOnly: true, jumpForwardSeconds: 30 }))
  expect(JSON.stringify(storage.write.mock.calls)).not.toContain('accessToken')
})
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm --filter @abs/mobile test -- src/settings/SettingsProvider.test.tsx
```

Expected: FAIL because settings are missing.

- [ ] **Step 3: Implement the agreed parity settings**

Include jump forward/back, default rate, sleep timer defaults, Wi-Fi-only downloads, internal/SAF destination, theme, connection management, log export, and local storage usage. Document every official mobile feature as `implemented`, `not applicable`, or `deferred after v1` with the exact destination issue.

```ts
export const DefaultMobileSettings = {
  jumpBackSeconds: 10,
  jumpForwardSeconds: 30,
  playbackRate: 1,
  wifiOnly: true,
  downloadDestination: 'internal',
  theme: 'dark'
} as const
```

- [ ] **Step 4: Run settings and parity checks**

```bash
pnpm --filter @abs/mobile test -- src/settings
rg -n '\| (implemented|not applicable|deferred after v1) \|' docs/mobile-parity.md
```

Expected: tests pass and every parity table row has one explicit disposition.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/settings mobile/src/routes/SettingsPage.tsx docs/mobile-parity.md
git commit -m "feat: complete ShelfDroid mobile settings"
```

### Task 6: Produce signed APK and AAB releases

**Files:**
- Create: `.github/workflows/android-release.yml`
- Modify: `mobile/android/app/build.gradle`
- Create: `mobile/android/keystore.properties.example`
- Create: `mobile/RELEASE.md`
- Modify: `mobile/package.json`

- [ ] **Step 1: Configure release signing from CI secrets**

```gradle
signingConfigs {
  release {
    storeFile file(System.getenv("ANDROID_KEYSTORE_PATH"))
    storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD")
    keyAlias System.getenv("ANDROID_KEY_ALIAS")
    keyPassword System.getenv("ANDROID_KEY_PASSWORD")
  }
}
buildTypes.release {
  signingConfig signingConfigs.release
  minifyEnabled true
  shrinkResources true
  proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
}
```

- [ ] **Step 2: Add release workflow verification**

```yaml
- run: pnpm install --frozen-lockfile
- run: pnpm --filter @abs/mobile test
- run: pnpm --filter @abs/mobile build
- run: pnpm --filter @abs/mobile cap:sync
- run: ./mobile/android/gradlew -p mobile/android testDebugUnitTest lintRelease bundleRelease assembleRelease
- uses: actions/upload-artifact@v4
  with:
    name: shelfdroid-release
    path: |
      mobile/android/app/build/outputs/apk/release/app-release.apk
      mobile/android/app/build/outputs/bundle/release/app-release.aab
```

- [ ] **Step 3: Verify versioning and upgrade installation**

```bash
pnpm --filter @abs/mobile release:check
apksigner verify --verbose mobile/android/app/build/outputs/apk/release/app-release.apk
adb install -r mobile/android/app/build/outputs/apk/release/app-release.apk
```

Expected: signature verifies and upgrade preserves login, downloads, settings, and recoverable playback.

- [ ] **Step 4: Run the final physical-device matrix**

Test Android 8/API 26, Android 12/API 31, and Android 15/API 35 for login, streaming, background playback, lock-screen controls, headset controls, downloads, airplane-mode playback, acquisition, Auto, widget, Cast, and links. Record pass/fail and device/build identifiers in `mobile/RELEASE.md`.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/android-release.yml mobile/android/app/build.gradle mobile/android/keystore.properties.example mobile/RELEASE.md mobile/package.json
git commit -m "build: release signed ShelfDroid Android artifacts"
```
