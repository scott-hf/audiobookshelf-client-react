# Android Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce an installable Android APK that connects to Audiobookshelf, browses books, streams audio, synchronizes progress, and uses the acquisition gateway.

**Architecture:** A Vite/React SPA is packaged locally by Capacitor under the unique application ID `com.hellofriend.shelfdroid`. It calls ABS directly with bearer tokens and calls the gateway through the shared client; navigation and state remain independent of Next.js server actions and cookies.

**Tech Stack:** React 19, Vite, TypeScript, React Router, Capacitor 7, Kotlin, Android SDK 35, Vitest, Playwright

---

## File Map

| Path | Responsibility |
|---|---|
| `mobile/package.json` | Mobile scripts and dependencies |
| `mobile/vite.config.ts` | Local SPA build |
| `mobile/capacitor.config.ts` | Capacitor app identity and packaged assets |
| `mobile/src/api/absClient.ts` | Token-aware ABS API |
| `mobile/src/auth/` | Connection/session state and refresh |
| `mobile/src/routes/` | Login, libraries, details, player, Discover, queue |
| `mobile/src/player/htmlAudioPlayer.ts` | Milestone-one streaming adapter |
| `mobile/android/` | Generated Android project and secure-session plugin |
| `.github/workflows/android.yml` | Repeatable debug APK build |

### Task 1: Scaffold the local mobile application

**Files:**
- Create: `mobile/package.json`
- Create: `mobile/tsconfig.json`
- Create: `mobile/vite.config.ts`
- Create: `mobile/index.html`
- Create: `mobile/capacitor.config.ts`
- Create: `mobile/src/main.tsx`
- Create: `mobile/src/App.tsx`
- Create: `mobile/src/styles.css`
- Test: `mobile/src/App.test.tsx`

- [ ] **Step 1: Write the failing shell test**

```tsx
it('renders the local mobile shell without a remote server URL', () => {
  render(<App />)
  expect(screen.getByRole('heading', { name: 'ShelfDroid' })).toBeInTheDocument()
  expect(capacitorConfig.server?.url).toBeUndefined()
  expect(capacitorConfig.webDir).toBe('dist')
})
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm --filter @abs/mobile test -- src/App.test.tsx
```

Expected: FAIL because the mobile package is absent.

- [ ] **Step 3: Add the Vite/Capacitor shell**

```ts
const config: CapacitorConfig = {
  appId: 'com.hellofriend.shelfdroid',
  appName: 'ShelfDroid',
  webDir: 'dist',
  android: { allowMixedContent: false },
  server: { androidScheme: 'https' }
}
export default config
```

Use `BrowserRouter`, a top app bar, a bottom navigation surface sized for touch, dark-theme CSS variables compatible with the web client palette, and `env(safe-area-inset-*)`.

- [ ] **Step 4: Build and test local assets**

```bash
pnpm install
pnpm --filter @abs/mobile test
pnpm --filter @abs/mobile build
```

Expected: tests pass and `mobile/dist/index.html` exists with local hashed assets.

- [ ] **Step 5: Commit**

```bash
git add mobile package.json pnpm-lock.yaml
git commit -m "feat: scaffold ShelfDroid React mobile app"
```

### Task 2: Implement ABS authentication and secure persistence

**Files:**
- Create: `mobile/src/api/absClient.ts`
- Create: `mobile/src/auth/session.ts`
- Create: `mobile/src/auth/AuthProvider.tsx`
- Create: `mobile/src/routes/LoginPage.tsx`
- Create: `mobile/src/native/secureSession.ts`
- Create: `mobile/android/app/src/main/java/com/hellofriend/shelfdroid/SecureSessionPlugin.kt`
- Modify: `mobile/android/app/src/main/java/com/hellofriend/shelfdroid/MainActivity.kt`
- Test: `mobile/src/auth/session.test.ts`
- Test: `mobile/android/app/src/test/java/com/hellofriend/shelfdroid/SecureSessionPluginTest.kt`

- [ ] **Step 1: Write failing login/refresh tests**

```ts
it('logs in, stores tokens, and retries one 401 after refresh', async () => {
  fetcher.mockResolvedValueOnce(json(loginResponse)).mockResolvedValueOnce(new Response('', { status: 401 }))
    .mockResolvedValueOnce(json(refreshResponse)).mockResolvedValueOnce(json(librariesResponse))
  await session.login('https://books.test', 'scott', 'password')
  await expect(client.getLibraries()).resolves.toEqual(librariesResponse)
  expect(vault.write).toHaveBeenLastCalledWith(expect.objectContaining({ accessToken: 'new-access', refreshToken: 'new-refresh' }))
})
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm --filter @abs/mobile test -- src/auth/session.test.ts
```

Expected: FAIL because session handling is missing.

- [ ] **Step 3: Implement normalized server URLs and token refresh**

```ts
export const normalizeServerUrl = (value: string) => {
  const url = new URL(value.includes('://') ? value : `https://${value}`)
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.toString().replace(/\/$/, '')
}

async function login(serverUrl: string, username: string, password: string) {
  const response = await fetch(`${serverUrl}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-return-tokens': 'true' },
    body: JSON.stringify({ username, password })
  })
  const data = await checkedJson<UserLoginWithTokensResponse>(response)
  await vault.write({ serverUrl, accessToken: data.user.accessToken, refreshToken: data.user.refreshToken })
  return data
}
```

The Kotlin plugin stores one JSON session blob with AndroidX Security encrypted preferences and exposes `read`, `write`, and `clear` Capacitor methods. Register it before `super.onCreate`.

- [ ] **Step 4: Run TypeScript and Android unit tests**

```bash
pnpm --filter @abs/mobile test -- src/auth/session.test.ts
./mobile/android/gradlew -p mobile/android testDebugUnitTest
```

Expected: both commands pass; log output never contains access or refresh tokens.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/api mobile/src/auth mobile/src/routes/LoginPage.tsx mobile/src/native mobile/android
git commit -m "feat: authenticate ShelfDroid securely"
```

### Task 3: Browse book libraries and item details

**Files:**
- Create: `mobile/src/types/abs.ts`
- Create: `mobile/src/routes/LibrariesPage.tsx`
- Create: `mobile/src/routes/LibraryPage.tsx`
- Create: `mobile/src/routes/BookDetailsPage.tsx`
- Create: `mobile/src/components/BookCard.tsx`
- Create: `mobile/src/components/LoadingView.tsx`
- Modify: `mobile/src/App.tsx`
- Test: `mobile/src/routes/LibraryPage.test.tsx`

- [ ] **Step 1: Write the failing browse test**

```tsx
it('shows only book libraries and opens item details', async () => {
  api.getLibraries.mockResolvedValue({ libraries: [library({ id: 'books', mediaType: 'book' }), library({ id: 'podcasts', mediaType: 'podcast' })] })
  api.getLibraryItems.mockResolvedValue({ results: [book({ id: 'b1', title: 'Project Hail Mary' })], total: 1 })
  renderMobile('/libraries', api)
  expect(await screen.findByText('Books')).toBeInTheDocument()
  expect(screen.queryByText('Podcasts')).not.toBeInTheDocument()
  await user.click(screen.getByText('Project Hail Mary'))
  expect(router.location.pathname).toBe('/library/books/item/b1')
})
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm --filter @abs/mobile test -- src/routes/LibraryPage.test.tsx
```

Expected: FAIL because browse routes are missing.

- [ ] **Step 3: Implement the minimum ABS endpoints**

```ts
getLibraries: () => request<GetLibrariesResponse>('/api/libraries'),
getLibraryItems: (id: string, page = 0) => request<GetLibraryItemsResponse>(`/api/libraries/${encodeURIComponent(id)}/items?limit=30&page=${page}&sort=media.metadata.title`),
getLibraryItem: (id: string) => request<LibraryItem>(`/api/items/${encodeURIComponent(id)}?expanded=1&include=progress`)
```

Render virtualized two-column covers, title, author, progress, pull-to-refresh, pagination, and a details screen with cover, metadata, duration, progress, and Play.

- [ ] **Step 4: Run browse tests and typecheck**

```bash
pnpm --filter @abs/mobile test -- src/routes/LibraryPage.test.tsx
pnpm --filter @abs/mobile typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/types mobile/src/routes mobile/src/components mobile/src/App.tsx
git commit -m "feat: browse Audiobookshelf from ShelfDroid"
```

### Task 4: Stream audio and synchronize progress

**Files:**
- Create: `mobile/src/player/playerTypes.ts`
- Create: `mobile/src/player/htmlAudioPlayer.ts`
- Create: `mobile/src/player/PlayerProvider.tsx`
- Create: `mobile/src/routes/PlayerPage.tsx`
- Modify: `mobile/src/api/absClient.ts`
- Test: `mobile/src/player/htmlAudioPlayer.test.ts`
- Test: `mobile/src/player/progressSync.test.ts`

- [ ] **Step 1: Write failing session/progress tests**

```ts
it('starts, syncs every 15 seconds, and closes with final progress', async () => {
  api.startSession.mockResolvedValue(session({ id: 's1', audioTracks: [track({ contentUrl: '/api/items/b1/file/f1' })] }))
  const player = createPlayerHarness(api)
  await player.play('b1')
  clock.advanceBy(15_000)
  expect(api.syncSession).toHaveBeenCalledWith('s1', expect.objectContaining({ currentTime: 15 }))
  await player.close()
  expect(api.closeSession).toHaveBeenCalledWith('s1', expect.any(Object))
})
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm --filter @abs/mobile test -- src/player
```

Expected: FAIL because playback state is missing.

- [ ] **Step 3: Implement HTML audio as the vertical-slice adapter**

```ts
const session = await api.startSession(itemId, {
  deviceInfo: { clientName: 'ShelfDroid', deviceId },
  supportedMimeTypes: ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/flac', 'application/vnd.apple.mpegurl'],
  mediaPlayer: 'html5',
  forceTranscode: false,
  forceDirectPlay: false
})
audio.src = api.authorizedStreamUrl(session.audioTracks[0].contentUrl)
audio.currentTime = session.currentTime
await audio.play()
```

Sync `currentTime` and delta `timeListened` every 15 seconds while playing; close on explicit stop, item replacement, and app background. The native player plan replaces this adapter without changing `PlayerProvider`.

- [ ] **Step 4: Run playback tests**

```bash
pnpm --filter @abs/mobile test -- src/player
```

Expected: PASS for start, seek, pause, periodic sync, close, and 401 refresh.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/player mobile/src/routes/PlayerPage.tsx mobile/src/api/absClient.ts
git commit -m "feat: stream and sync mobile playback"
```

### Task 5: Add Discover and acquisition queue

**Files:**
- Create: `mobile/src/api/acquisitionClient.ts`
- Create: `mobile/src/routes/DiscoverPage.tsx`
- Create: `mobile/src/routes/AcquisitionQueuePage.tsx`
- Create: `mobile/src/components/ReleaseCard.tsx`
- Create: `mobile/src/components/AcquisitionRow.tsx`
- Modify: `mobile/src/App.tsx`
- Test: `mobile/src/routes/DiscoverPage.test.tsx`
- Test: `mobile/src/routes/AcquisitionQueuePage.test.tsx`

- [ ] **Step 1: Write the failing gateway-auth test**

```ts
it('uses the ABS access token for gateway calls and opens confirmed items', async () => {
  await acquisition.search('lib1', 'Project Hail Mary')
  expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('/acquisition-api/v1/libraries/lib1/search'), expect.objectContaining({
    headers: expect.any(Headers)
  }))
  expect((fetcher.mock.calls[0][1].headers as Headers).get('authorization')).toBe('Bearer access')
  render(<AcquisitionRow acquisition={available({ absItemId: 'abs1' })} />)
  expect(screen.getByRole('link', { name: 'Open Book' })).toHaveAttribute('href', '/library/lib1/item/abs1')
})
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm --filter @abs/mobile test -- src/routes/DiscoverPage.test.tsx src/routes/AcquisitionQueuePage.test.tsx
```

Expected: FAIL because mobile acquisition routes are missing.

- [ ] **Step 3: Reuse the shared client**

```ts
export const acquisitionClient = createAcquisitionClient({
  baseUrl: `${session.serverUrl}/acquisition-api/v1`,
  getAccessToken: async () => session.accessToken
})
```

Match the web flow: exact release cards, confirmation, UUID idempotency, clamped/indeterminate progress, SSE with 10-second fallback, retry/cancel, and Open Book.

- [ ] **Step 4: Run mobile acquisition tests**

```bash
pnpm --filter @abs/mobile test -- src/routes/DiscoverPage.test.tsx src/routes/AcquisitionQueuePage.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/api/acquisitionClient.ts mobile/src/routes/DiscoverPage.tsx mobile/src/routes/AcquisitionQueuePage.tsx mobile/src/components mobile/src/App.tsx
git commit -m "feat: acquire audiobooks from ShelfDroid"
```

### Task 6: Generate Android, CI, and physical-device smoke test

**Files:**
- Create: `mobile/android/`
- Create: `.github/workflows/android.yml`
- Create: `mobile/e2e/vertical-slice.spec.ts`
- Create: `mobile/README.md`

- [ ] **Step 1: Generate and sync the Android project**

```bash
pnpm --filter @abs/mobile build
pnpm --filter @abs/mobile exec cap add android
pnpm --filter @abs/mobile exec cap sync android
```

Expected: `mobile/android/gradlew` and `mobile/android/app/src/main/assets/public/index.html` exist.

- [ ] **Step 2: Lock the Android baseline**

```gradle
android {
  namespace 'com.hellofriend.shelfdroid'
  compileSdk 35
  defaultConfig {
    applicationId 'com.hellofriend.shelfdroid'
    minSdk 24
    targetSdk 35
  }
}
```

Require `INTERNET` and `POST_NOTIFICATIONS`; disallow cleartext traffic in release.

- [ ] **Step 3: Add CI build commands**

```yaml
- run: pnpm install --frozen-lockfile
- run: pnpm --filter @abs/mobile test
- run: pnpm --filter @abs/mobile build
- run: pnpm --filter @abs/mobile cap:sync
- run: ./mobile/android/gradlew -p mobile/android testDebugUnitTest assembleDebug
- uses: actions/upload-artifact@v4
  with:
    name: shelfdroid-debug-apk
    path: mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

- [ ] **Step 4: Run the local release gate**

```bash
pnpm --filter @abs/mobile test
pnpm --filter @abs/mobile build
pnpm --filter @abs/mobile cap:sync
./mobile/android/gradlew -p mobile/android testDebugUnitTest assembleDebug
adb install -r mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

Expected: APK installs alongside official ABS; login, browse, stream, progress sync, Discover, queue, and Open Book pass on a physical device.

- [ ] **Step 5: Commit**

```bash
git add mobile/android mobile/e2e mobile/README.md .github/workflows/android.yml
git commit -m "build: produce ShelfDroid Android vertical slice"
```
