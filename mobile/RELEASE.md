# ShelfDroid Android release process

WI-1496 t900 Task 6 (unsigned CI slice). Signing itself is deferred to t950,
`@user`-owned and gated on Scott providing a real release keystore -- **this
document and the workflow it describes never generate, source, or commit any
key material.**

## Current state (as of this task)

- `.github/workflows/android-release.yml` exists and is `workflow_dispatch`-only
  (not on push/PR -- it is not wired up yet, deliberately, until t950).
- `mobile/android/app/build.gradle`'s `signingConfigs.release` block is
  guarded behind `hasReleaseSigningEnv` (true only when
  `ANDROID_KEYSTORE_PATH` is set). In every environment without the four
  secrets below -- including this dev machine -- `bundleRelease`/
  `assembleRelease` still run to completion and produce **unsigned**
  artifacts; they are not installable/upgradeable on a device until t950
  configures real signing.
- No repository secrets are configured yet. Configuring them is part of
  t950, not this task.

## The four secrets

Set these as GitHub Actions repository (or environment) secrets before the
release workflow can produce a signed artifact. Never put real values in
this repo, in code, in commit messages, or in CI logs (the workflow passes
them through as `env:`, never printed).

| Secret | Meaning |
| --- | --- |
| `ANDROID_KEYSTORE_PATH` | Path (inside the CI runner, e.g. after decoding a base64 secret to a temp file) to the release `.keystore`/`.jks` file. |
| `ANDROID_KEYSTORE_PASSWORD` | Password protecting that keystore file. |
| `ANDROID_KEY_ALIAS` | Alias of the signing key inside the keystore. |
| `ANDROID_KEY_PASSWORD` | Password protecting that specific key (may differ from the keystore password). |

`mobile/android/keystore.properties.example` documents the equivalent
properties-file shape for a maintainer signing a build locally instead of
via CI -- copy it to `keystore.properties`, fill in real values, and never
commit that copy.

## Running the release workflow (once t950 has configured the secrets)

1. Trigger `.github/workflows/android-release.yml` via `workflow_dispatch`
   (Actions tab -> "Android Release" -> "Run workflow").
2. It installs dependencies, runs the mobile unit test suite, builds the
   web bundle, syncs Capacitor, then runs
   `./gradlew testDebugUnitTest lintRelease bundleRelease assembleRelease`
   inside `mobile/android` with the four secrets as env vars.
3. On success it uploads `app-release.apk` and `app-release.aab` as the
   `shelfdroid-release` workflow artifact.

## What is explicitly NOT part of this task (t950's scope)

- Generating or committing any keystore/cert material.
- `apksigner verify` against a signed artifact.
- `adb install -r` upgrade-preserves-state smoke testing.
- The physical-device test matrix (Android 8/API 26, Android 12/API 31,
  Android 15/API 35 -- login, streaming, background playback, lock-screen
  controls, headset controls, downloads, airplane-mode playback,
  acquisition, Auto, widget, Cast, links). Results for that matrix belong
  in this file once t950 runs it, keyed by device/build identifier.
- Wiring `android-release.yml` onto an automatic trigger (push/tag) -- it
  stays `workflow_dispatch`-only until a real signed release process exists
  end-to-end.

## `release:check`

`corepack pnpm --filter @abs/mobile release:check` (`mobile/scripts/release-check.mjs`)
reads `versionCode`/`versionName` out of `mobile/android/app/build.gradle`
and prints them -- a cheap version-metadata sanity check, deliberately not a
signed-artifact check (that's `apksigner verify`, t950's job once a real
signed APK exists).
