# Android Offline Downloads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persistent, resumable audiobook downloads and offline playback without weakening native streaming playback.

**Architecture:** Port the official app’s downloader, foreground transfer service, filesystem bridge, and local catalog from donor commit `12025ab59a5c9f5654b31b4b68c1fc71ad676f61`. Store internal downloads by ABS item ID, persist queue/catalog state natively, and expose a narrow typed bridge to React.

**Tech Stack:** Kotlin, OkHttp, SQLite, Capacitor 7, Android Storage Access Framework, foreground data-sync service, Vitest, JUnit, instrumented tests

---

## File Map

| Destination | Responsibility |
|---|---|
| `mobile/android/.../plugins/AbsDownloader.kt` | React-native download bridge |
| `mobile/android/.../services/DownloadService.kt` | Foreground transfer lifecycle |
| `mobile/android/.../managers/DownloadItemManager.kt` | Queue, retry, completion |
| `mobile/android/.../managers/DbManager.kt` | Catalog and queue persistence |
| `mobile/android/.../device/FolderScanner.kt` | Reconcile disk/catalog |
| `mobile/android/.../plugins/AbsFileSystem.kt` | Internal/SAF folder operations |
| `mobile/src/downloads/DownloadProvider.tsx` | React queue/cache |
| `mobile/src/routes/DownloadsPage.tsx` | Offline library and queue |
| `mobile/src/player/offlineSource.ts` | Local track selection |

### Task 1: Define the download and offline catalog contracts

**Files:**
- Create: `mobile/src/downloads/downloadTypes.ts`
- Create: `mobile/src/native/absDownloaderPlugin.ts`
- Create: `mobile/src/native/absFileSystemPlugin.ts`
- Test: `mobile/src/downloads/downloadTypes.test.ts`

- [ ] **Step 1: Write the failing progress test**

```ts
it('clamps aggregate progress and distinguishes queued from complete', () => {
  expect(toDownloadSnapshot({ id: 'b1', bytesDownloaded: 150, totalBytes: 100, state: 'running' })).toMatchObject({ progressPercent: 100, state: 'running' })
  expect(toDownloadSnapshot({ id: 'b2', bytesDownloaded: 0, totalBytes: 0, state: 'queued' }).progressPercent).toBeNull()
})
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm --filter @abs/mobile test -- src/downloads/downloadTypes.test.ts
```

Expected: FAIL because download types are missing.

- [ ] **Step 3: Define the bridge contract**

```ts
export type DownloadState = 'queued' | 'running' | 'paused' | 'waiting_for_network' | 'waiting_for_space' | 'complete' | 'failed' | 'cancelled'
export interface DownloadSnapshot {
  id: string
  libraryItemId: string
  title: string
  bytesDownloaded: number
  totalBytes: number
  progressPercent: number | null
  state: DownloadState
  error: string | null
}
export interface LocalLibraryItem {
  libraryItemId: string
  serverConnectionId: string
  folderUri: string
  manifestJson: string
  completedAt: number
}
```

Expose `enqueue`, `pause`, `resume`, `cancel`, `remove`, `listQueue`, `listLocalItems`, and event listeners.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @abs/mobile test -- src/downloads/downloadTypes.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/downloads mobile/src/native
git commit -m "feat: define offline download contracts"
```

### Task 2: Port native persistence and filesystem support

**Files:**
- Create: `mobile/android/app/src/main/java/com/hellofriend/shelfdroid/managers/DbManager.kt`
- Create: `mobile/android/app/src/main/java/com/hellofriend/shelfdroid/device/FolderScanner.kt`
- Create: `mobile/android/app/src/main/java/com/hellofriend/shelfdroid/plugins/AbsDatabase.kt`
- Create: `mobile/android/app/src/main/java/com/hellofriend/shelfdroid/plugins/AbsFileSystem.kt`
- Create: `mobile/android/app/src/main/java/com/hellofriend/shelfdroid/models/DownloadItem.kt`
- Create: `mobile/android/app/src/main/java/com/hellofriend/shelfdroid/models/DownloadItemPart.kt`
- Create: `mobile/android/app/src/main/java/com/hellofriend/shelfdroid/data/LocalLibraryItem.kt`
- Modify: `mobile/android/app/src/main/java/com/hellofriend/shelfdroid/MainActivity.kt`
- Test: `mobile/android/app/src/test/java/com/hellofriend/shelfdroid/managers/DbManagerTest.kt`

- [ ] **Step 1: Write the failing restart persistence test**

```kotlin
@Test fun queueAndLocalItemRoundTripAcrossDatabaseReopen() {
  val first = testDatabase()
  first.saveDownload(download("b1", "running"))
  first.saveLocalItem(localItem("b2"))
  first.close()
  val reopened = testDatabase()
  assertEquals("running", reopened.downloads().single().state)
  assertEquals("b2", reopened.localItems().single().libraryItemId)
}
```

- [ ] **Step 2: Run and confirm failure**

```bash
./mobile/android/gradlew -p mobile/android testDebugUnitTest --tests '*DbManagerTest'
```

Expected: FAIL because native persistence is missing.

- [ ] **Step 3: Port and adapt donor persistence**

Port the named donor files, change the package, and retain only book/offline fields used by the bridge. Use internal app storage by default at `filesDir/downloads/{serverConnectionId}/{libraryItemId}`. SAF destinations persist URI permission before queueing.

```kotlin
fun finalInternalPath(connectionId: String, itemId: String): File =
  File(context.filesDir, "downloads/${safeId(connectionId)}/${safeId(itemId)}")
```

Register `AbsDatabase` and `AbsFileSystem` in `MainActivity`.

- [ ] **Step 4: Run persistence and path tests**

```bash
./mobile/android/gradlew -p mobile/android testDebugUnitTest
```

Expected: PASS for reopen, schema creation, path confinement, folder scan, missing file, and SAF permission tests.

- [ ] **Step 5: Commit**

```bash
git add mobile/android/app/src/main/java/com/hellofriend/shelfdroid mobile/android/app/src/test
git commit -m "feat: persist ShelfDroid offline catalog"
```

### Task 3: Port the foreground downloader

**Files:**
- Create: `mobile/android/app/src/main/java/com/hellofriend/shelfdroid/plugins/AbsDownloader.kt`
- Create: `mobile/android/app/src/main/java/com/hellofriend/shelfdroid/managers/DownloadItemManager.kt`
- Create: `mobile/android/app/src/main/java/com/hellofriend/shelfdroid/managers/InternalDownloadManager.kt`
- Create: `mobile/android/app/src/main/java/com/hellofriend/shelfdroid/managers/IncompleteDownloadCleanup.kt`
- Create: `mobile/android/app/src/main/java/com/hellofriend/shelfdroid/services/DownloadService.kt`
- Create: `mobile/android/app/src/main/java/com/hellofriend/shelfdroid/services/DownloadServiceHost.kt`
- Modify: `mobile/android/app/src/main/AndroidManifest.xml`
- Test: `mobile/android/app/src/test/java/com/hellofriend/shelfdroid/managers/DownloadItemManagerTest.kt`

- [ ] **Step 1: Write the failing resume test**

```kotlin
@Test fun interruptedPartResumesFromPersistedByteOffset() = runTest {
  server.respondToRange("bytes=1024-", remainingBytes)
  repository.save(part(bytesDownloaded = 1024, state = "queued"))
  manager.restoreQueue()
  manager.awaitIdle()
  assertEquals("bytes=1024-", server.lastRequest.headers["Range"])
  assertEquals("complete", repository.part("p1").state)
}
```

- [ ] **Step 2: Run and confirm failure**

```bash
./mobile/android/gradlew -p mobile/android testDebugUnitTest --tests '*DownloadItemManagerTest'
```

Expected: FAIL because the downloader is absent.

- [ ] **Step 3: Port the donor queue and harden transfers**

Download every audio track plus cover and ebook where present into `download-staging/{itemId}` using `.part` files. Use authenticated OkHttp range requests, persist every part boundary, verify final byte count, then rename into the final item folder and write the local manifest.

```xml
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />
<service
    android:name=".services.DownloadService"
    android:exported="false"
    android:foregroundServiceType="dataSync" />
```

Honor Wi-Fi-only policy before starting each part; use `waiting_for_network` and `waiting_for_space` instead of failing.

- [ ] **Step 4: Run download tests**

```bash
./mobile/android/gradlew -p mobile/android testDebugUnitTest
```

Expected: PASS for ranges, 401 refresh, byte mismatch, process restore, cancellation, disk exhaustion, Wi-Fi policy, and completion rename.

- [ ] **Step 5: Commit**

```bash
git add mobile/android/app/src/main/java/com/hellofriend/shelfdroid mobile/android/app/src/main/AndroidManifest.xml mobile/android/app/src/test
git commit -m "feat: port persistent native audiobook downloads"
```

### Task 4: Add the React download queue and offline library

**Files:**
- Create: `mobile/src/downloads/DownloadProvider.tsx`
- Create: `mobile/src/routes/DownloadsPage.tsx`
- Create: `mobile/src/components/DownloadRow.tsx`
- Modify: `mobile/src/routes/BookDetailsPage.tsx`
- Modify: `mobile/src/App.tsx`
- Test: `mobile/src/routes/DownloadsPage.test.tsx`

- [ ] **Step 1: Write the failing UI test**

```tsx
it('queues a book once and exposes completed items offline', async () => {
  plugin.enqueue.resolves()
  renderBookDetails(bookFixture)
  await user.click(screen.getByRole('button', { name: 'Download' }))
  expect(plugin.enqueue).toHaveBeenCalledTimes(1)
  plugin.emit('downloadComplete', completeSnapshot)
  navigate('/downloads')
  expect(await screen.findByText('Project Hail Mary')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Play offline' })).toBeEnabled()
})
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm --filter @abs/mobile test -- src/routes/DownloadsPage.test.tsx
```

Expected: FAIL because download UI is missing.

- [ ] **Step 3: Implement queue state and controls**

```tsx
const download = async (item: LibraryItem) => {
  if (queue.some((entry) => entry.libraryItemId === item.id && entry.state !== 'failed')) return
  await AbsDownloader.enqueue({ libraryItemJson: JSON.stringify(item), connectionId: session.connectionId })
}
```

Show aggregate progress, current filename, pause/resume/cancel, retryable errors, storage policy, and local items. Disable duplicate queueing.

- [ ] **Step 4: Run React tests**

```bash
pnpm --filter @abs/mobile test -- src/routes/DownloadsPage.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/downloads mobile/src/routes mobile/src/components mobile/src/App.tsx
git commit -m "feat: add ShelfDroid offline library UI"
```

### Task 5: Play local tracks and verify interruption recovery

**Files:**
- Create: `mobile/src/player/offlineSource.ts`
- Create: `mobile/src/player/offlineSource.test.ts`
- Modify: `mobile/src/player/PlayerProvider.tsx`
- Modify: `mobile/android/app/src/main/java/com/hellofriend/shelfdroid/plugins/AbsAudioPlayer.kt`
- Create: `mobile/android/app/src/androidTest/java/com/hellofriend/shelfdroid/downloads/OfflineJourneyTest.kt`

- [ ] **Step 1: Write the failing source selection test**

```ts
it('prefers a complete local manifest and never uses a partial item', () => {
  expect(selectPlaybackSource(item, completeLocalManifest)).toMatchObject({ kind: 'offline' })
  expect(selectPlaybackSource(item, partialLocalManifest)).toMatchObject({ kind: 'stream' })
})
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm --filter @abs/mobile test -- src/player/offlineSource.test.ts
```

Expected: FAIL because offline source selection is missing.

- [ ] **Step 3: Add local URI playback**

```ts
export function selectPlaybackSource(item: LibraryItem, local: LocalManifest | null): PlaybackSource {
  if (local?.complete && local.tracks.length > 0) return { kind: 'offline', tracks: local.tracks }
  return { kind: 'stream', itemId: item.id }
}
```

The native plugin accepts `content://` and app-internal file URIs, preserves track order, and still opens/syncs an ABS playback session when network returns.

- [ ] **Step 4: Run the offline release gate**

```bash
pnpm --filter @abs/mobile test
./mobile/android/gradlew -p mobile/android testDebugUnitTest connectedDebugAndroidTest assembleDebug
```

Expected: a download interrupted by process death resumes; completed content plays in airplane mode; deleting a local item stops playback cleanly and removes catalog plus files.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/player mobile/android/app/src/main/java/com/hellofriend/shelfdroid/plugins mobile/android/app/src/androidTest
git commit -m "feat: play downloaded audiobooks offline"
```
