# ShelfDroid (mobile)

Local Vite/React SPA packaged by Capacitor into an installable Android APK (`com.hellofriend.shelfdroid`). Calls Audiobookshelf and the acquisition gateway directly with bearer tokens -- no cookies, no Next.js server actions.

## Prerequisites

- Node v22+ (this repo pins `pnpm@10.33.0`; `pnpm` is often **not on PATH** -- use `corepack pnpm ...` for every command below).
- Android SDK (`local.properties`'s `sdk.dir`, machine-local and gitignored -- create it if missing, e.g. `sdk.dir=C:/Users/<you>/AppData/Local/Android/Sdk`).
- **JDK 21**, not whatever your machine's default `JAVA_HOME` is. AGP 8.7.2 / capacitor-android require JDK 21; a JDK 17 `JAVA_HOME` fails Gradle with `invalid source release: 21`. Point `JAVA_HOME` at a JDK 21 install for every Gradle command below (e.g. Android Studio's bundled `jbr`, or a `.gradle/jdks/...-21-...` toolchain if Gradle's auto-provisioning already resolved one on your machine).

## Web-layer commands

```bash
corepack pnpm --filter @abs/mobile test        # Vitest
corepack pnpm --filter @abs/mobile typecheck   # tsc -b --noEmit
corepack pnpm --filter @abs/mobile build       # -> mobile/dist
corepack pnpm --filter @abs/mobile cap:sync    # copy dist into android/app/src/main/assets/public
```

## Android build

```bash
# from repo root, after build + cap:sync above
JAVA_HOME=<path to a JDK 21> ./mobile/android/gradlew -p mobile/android testDebugUnitTest assembleDebug
```

Produces `mobile/android/app/build/outputs/apk/debug/app-debug.apk`. Install alongside the official ABS app for manual smoke testing (`adb install -r <path>`); the debug build's `applicationIdSuffix ".debug"` keeps the two package IDs distinct.

## e2e (Playwright)

```bash
corepack pnpm --filter @abs/mobile exec playwright install chromium   # once
corepack pnpm --filter @abs/mobile e2e
```

Runs `mobile/e2e/vertical-slice.spec.ts` against the plain Vite dev server (not the packaged Capacitor WebView -- a real device/emulator run is out of scope for this repo's CI and is covered separately by the manual physical-device smoke pass) and a disposable in-memory fake ABS + acquisition-gateway backend (`mobile/e2e/support/fakeAbsServer.mjs`, zero dependencies, started automatically by `playwright.config.ts`'s `webServer`). The spec exercises login -> browse -> item details -> stream -> Discover search -> acquire -> queue state.

## Architecture notes

- `src/auth/session.ts` owns the bearer-token session (server URL + access/refresh tokens), persisted through `src/native/secureSession.ts` -> `android/app/.../SecureSessionPlugin.kt` (AndroidX Security encrypted `SharedPreferences`). Tokens are never written to React-side storage (`localStorage`/`IndexedDB`) or logged.
- `src/api/absClient.ts` and `src/api/acquisitionClient.ts` both retry exactly once on a 401 via `SessionStore.refresh()`, mirroring the web app's cookie-based refresh-and-retry contract with bearer tokens instead of cookies.
- `src/contexts/AcquisitionContext.tsx` is deliberately **poll-only**, unlike the web app's SSE-with-poll-fallback: a browser `EventSource` cannot attach a custom `Authorization` header, and the gateway's `/acquisition-api/v1/events` route only accepts a bearer header or an ABS cookie -- neither of which an unauthenticated `EventSource` from a bearer-only client can supply. Polling every 10s for actively-viewed libraries is the web app's own SSE-disconnected fallback, made permanent here.
- `src/player/htmlAudioPlayer.ts` is the milestone-one playback adapter (`<audio>` + periodic progress sync); a later native player can replace it without changing `PlayerProvider`'s contract.

## Known gotchas

- `vite.config.ts` / `vitest.config.ts` override `css.postcss.plugins` to `[]` -- otherwise Vite walks up to the root Next.js app's Tailwind v4 `postcss.config.mjs`, which is incompatible with Vite's default postcss loader, and crashes. Any *new* Vite/Vitest-family config file in this package (e.g. for a future dev-server tool) needs the same override.
- Android unit tests with `testOptions.unitTests.returnDefaultValues = true` silently break `com.getcapacitor.JSObject`'s `put`/`getString` (returns `null` instead of real values) unless `testImplementation "org.json:json:20240303"` is present in `android/app/build.gradle`.
