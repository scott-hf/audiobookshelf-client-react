# Mobile Acquisition Master Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a standalone acquisition gateway, React web acquisition UI, and a true React/Capacitor Android app without modifying Audiobookshelf server source.

**Architecture:** This repository becomes a pnpm workspace containing the existing Next.js client, shared acquisition packages, a separately deployed Fastify gateway, and a Vite/Capacitor mobile app. Librarr downloads and organizes into a staging volume; the gateway owns final handoff, ABS scan, item resolution, and the public client contract.

**Tech Stack:** pnpm 10, TypeScript 5, Zod, Fastify, SQLite, Vitest, Next.js 16, React 19, Cypress 15, Vite, Capacitor 7, Kotlin, ExoPlayer, Android SDK 35

---

## Baselines

- React fork: `scott-hf/audiobookshelf-client-react`, baseline `ff3274f`
- Design: `docs/superpowers/specs/2026-08-24-audiobookshelf-react-mobile-acquisition-design.md`
- Librarr donor/API reference: `JeremiahM37/librarr`
- Android native donor: `advplyr/audiobookshelf-app`
- Android application ID: `com.hellofriend.shelfdroid`
- Public gateway path: `/acquisition-api/v1`
- Librarr `AUDIOBOOK_DIR`: gateway staging root
- Librarr `ABS_URL`, `ABS_TOKEN`, and `ABS_LIBRARY_ID`: unset in this deployment

## Plan Dependency Map

| Order | Plan | Depends on | Working checkpoint |
|---|---|---|---|
| 1 | [Gateway foundation](2026-08-24-acquisition-gateway-foundation-implementation-plan.md) | Approved design | Authenticated status API and persistent SQLite store |
| 2 | [Librarr acquisition flow](2026-08-24-librarr-acquisition-flow-implementation-plan.md) | 1 | Exact release search, submit, queue, retry, cancel, SSE |
| 3 | [Filesystem import](2026-08-24-acquisition-import-handoff-implementation-plan.md) | 2 | Staged output becomes a confirmed ABS item without partial visibility |
| 4 | [React web UI](2026-08-24-react-web-acquisition-implementation-plan.md) | 3 | Browser search-to-Open-Book journey |
| 5 | [Android vertical slice](2026-08-24-android-vertical-slice-implementation-plan.md) | 3 | Installable APK with browse, stream, progress, and acquisition |
| 6 | [Native playback](2026-08-24-android-native-playback-implementation-plan.md) | 5 | Foreground playback survives WebView and process lifecycle events |
| 7 | [Offline downloads](2026-08-24-android-offline-downloads-implementation-plan.md) | 6 | Persistent offline catalog and resumable downloads |
| 8 | [Extended Android parity](2026-08-24-android-extended-parity-implementation-plan.md) | 7 | Android Auto, widget, Cast, deep links, and release pipeline |

Plans 4 and 5 may run in parallel after Plan 3 passes. Plans 6 through 8 remain sequential because each reuses the preceding native service layer.

## Required Review Gates

- [ ] **Gate 1:** Contract schemas, authentication, migrations, and status endpoint pass Plan 1 verification.
- [ ] **Gate 2:** Fake-Librarr integration proves exact identity and idempotent submission.
- [ ] **Gate 3:** Disposable-volume tests prove restart-safe handoff and ABS item resolution.
- [ ] **Gate 4:** Web UI completes the Cypress search-to-Open-Book journey.
- [ ] **Gate 5:** Android vertical slice passes physical-device browse, playback, progress, and acquisition smoke tests.
- [ ] **Gate 6:** Native player passes lock-screen, headset, background, and process-recovery tests.
- [ ] **Gate 7:** Offline downloads pass interruption, storage exhaustion, and cleanup tests.
- [ ] **Gate 8:** Signed AAB/APK installs cleanly and all extended integrations pass release smoke tests.

## Deployment Invariants

- Audiobookshelf source, database schema, and server image remain unchanged.
- Provider secrets exist only in gateway, Librarr, and Decypharr container configuration.
- The public proxy exposes gateway routes on the same HTTPS origin as the web client.
- The Android app calls the same public gateway path with an ABS bearer token.
- Librarr writes to staging and never scans Audiobookshelf in this stack.
- The gateway is the only process allowed to move staged content into mapped ABS library roots.
- `available` always includes a confirmed `absItemId`.

## Full Verification

- [ ] Run all workspace checks:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm -r test
pnpm build
```

Expected: all commands exit `0`.

- [ ] Run the disposable integration stack:

```bash
docker compose -f deploy/acquisition/docker-compose.test.yml up --build --abort-on-container-exit gateway-e2e
```

Expected: `gateway-e2e` exits `0`; no path outside the disposable volume changes.

- [ ] Build the Android artifacts:

```bash
pnpm --filter @abs/mobile build
pnpm --filter @abs/mobile cap:sync
./mobile/android/gradlew -p mobile/android testDebugUnitTest connectedDebugAndroidTest assembleDebug bundleRelease
```

Expected: unit and instrumented tests pass; debug APK and release AAB are produced.

## Droplet Rollout

- [ ] Start the gateway with fake ABS and Librarr adapters and confirm authenticated `/status` returns `ready: true`.
- [ ] Point the gateway at Librarr with mutation routes disabled; verify audiobook search and confirm client responses contain no provider URLs.
- [ ] Set Librarr `AUDIOBOOK_DIR=/media/staging`; unset Librarr `ABS_URL`, `ABS_TOKEN`, and `ABS_LIBRARY_ID`; acquire into the isolated staging volume.
- [ ] Map one disposable ABS book library to `/media/disposable-library`; complete an import and confirm the returned `absItemId` opens the expected book.
- [ ] Restart gateway, Librarr, and ABS independently during `downloading`, `importing`, and `scanning`; confirm no duplicate download and no partial visible import.
- [ ] Route `/acquisition-api/*` to the gateway on the public HTTPS origin and deploy the React web routes.
- [ ] Enable the production library mapping only after the disposable journey passes.
- [ ] Install the debug APK and run the physical-device vertical-slice checklist against the public origin.
- [ ] Back up the gateway SQLite volume and capture rollback commands before enabling acquisition for normal use.

Use explicit service names and verify configuration without printing secrets:

```bash
docker compose -f deploy/acquisition/docker-compose.yml config --services
docker compose -f deploy/acquisition/docker-compose.yml up -d acquisition-gateway
docker compose -f deploy/acquisition/docker-compose.yml ps
curl -fsS https://books.example.com/acquisition-api/v1/status | jq '{version,ready,libraries}'
```

Expected: the service list contains `acquisition-gateway`; all containers are healthy; the public status response contains no token, API key, provider URL, or filesystem path.

## Final Commit

- [ ] Commit the verified integrated result:

```bash
git add package.json pnpm-lock.yaml pnpm-workspace.yaml packages services src cypress mobile deploy .github docs
git commit -m "feat: deliver mobile acquisition stack"
```

Expected: one final integration commit after the smaller task commits in each child plan.
