# Settled Decisions and Defaults

These answers are approved. Claude should implement them without asking follow-up questions unless repository evidence makes one technically impossible.

## Product and scope

| Question | Answer |
|---|---|
| Target repository | `scott-hf/audiobookshelf-client-react` |
| Primary product | Android mobile app, with the web client receiving the same acquisition feature |
| Android app name | ShelfDroid |
| Android application ID | `com.hellofriend.shelfdroid` |
| Android v1 | Android only; iOS is out of scope |
| Android packaging | React 19 + Vite SPA packaged locally with Capacitor 7 |
| TWA or hosted WebView | Neither; no production remote `server.url` |
| Initial mobile capability | Login, book libraries, item details, streaming, progress sync, acquisition, queue, Open Book |
| Later milestones in this package | Native player, offline downloads, Auto/widget/Cast/deep links/release pipeline |

## Service boundaries

| Question | Answer |
|---|---|
| Modify Audiobookshelf server? | No. Source, image, database, routes, sockets, and settings remain upstream-clean. |
| Where acquisition logic lives | Standalone `acquisition-gateway` service in the React fork workspace |
| Gateway stack | Node/TypeScript, Fastify 5, Zod, `better-sqlite3`, Pino, Vitest |
| Search/download authority | Librarr |
| Final import authority | Acquisition gateway |
| Audiobookshelf authority | Users, permissions, libraries, catalog, playback, progress, streaming |
| Default debrid path | Librarr → Decypharr → TorBox |
| Provider selection in UI/API | None |

## Repository layout

Keep the existing Next.js application at repository root. Add:

```text
packages/acquisition-contract
packages/acquisition-client
services/acquisition-gateway
mobile
deploy/acquisition
```

Use pnpm workspaces. Do not move the root Next.js source into a new directory just to create a monorepo.

## Public API and authentication

- Public prefix: `/acquisition-api/v1`.
- Add an unprivileged internal `/healthz` endpoint returning only `{ "ok": true }`; no configuration or dependency detail.
- `GET /acquisition-api/v1/status` remains authenticated.
- Web: accept the same-origin `access_token` HTTP-only cookie. The gateway forwards it as `Authorization: Bearer` to ABS `GET /api/me`.
- Android: accept `Authorization: Bearer <ABS access token>`.
- If both cookie and bearer are present, bearer wins.
- Never accept the gateway’s ABS service token from a client.
- Cache successful user validation by a SHA-256 token fingerprint for 30 seconds. Do not cache failures. Never store or log the raw token.
- Authorize only active users who can access the requested book library. Admin/access-all users are allowed; otherwise require the library ID in the user’s accessible/allowed library set.
- Queue/history/detail/retry/cancel endpoints are always filtered by authenticated ABS user ID. Foreign and missing acquisition IDs return the same `404 acquisition_not_found`.

## API behavior

- Search requires a trimmed query of 2–200 Unicode characters.
- Search snapshots expire after 900 seconds.
- Clients receive opaque `searchSessionId` and `releaseId`; they never submit magnets, NZB URLs, provider URLs, or raw Librarr result objects.
- Acquisition creation requires a client-generated UUID idempotency key.
- Reuse of `(absUserId, idempotencyKey)` returns the existing record and never creates another Librarr job.
- Torrent results are requestable only if an `info_hash` exists or BTIH can be extracted from the magnet.
- NZB results are requestable because Librarr normally returns `nzo_id`. If submission is accepted without an ID, persist `needs_attention` and do not auto-resubmit.
- SSE is user-scoped. Retain the latest 100 events per user in memory and support `Last-Event-ID`; polling remains the recovery path.
- Normal states: `queued`, `submitted`, `downloading`, `processing`, `staged`, `importing`, `scanning`, `available`.
- Intervention/terminal states: `failed`, `cancelled`, `needs_attention`.
- Clamp progress to `0..100`; never regress a persisted lifecycle state because of stale provider data.

## Persistence defaults

- SQLite path: `/data/acquisition.sqlite`.
- Enable WAL mode, foreign keys, and a 5-second busy timeout.
- Run numbered, transactional, forward-only migrations at startup.
- Search TTL: 900 seconds.
- Terminal history retention: 30 days.
- Reconciliation interval: 5 seconds with bounded exponential backoff for unavailable dependencies.
- Store timestamps as UTC ISO-8601 strings.
- Persist state before and after every non-idempotent external side effect.
- Do not store raw access tokens, refresh tokens, Librarr API keys, ABS service tokens, magnets, or NZB URLs in SQLite.

## Filesystem handoff

- Librarr `AUDIOBOOK_DIR` is the gateway staging root.
- Librarr `ABS_URL`, `ABS_TOKEN`, and `ABS_LIBRARY_ID` must be unset.
- Each ABS library ID maps explicitly to one final root; no implicit default library.
- Staging and final roots must be absolute, existing at startup in production, non-overlapping after `realpath`, and not `/`.
- Reject path traversal, symlinks, sockets, devices, FIFOs, empty audio sets, and content outside staging.
- Supported audio: `.m4b`, `.mp3`, `.m4a`, `.aac`, `.flac`, `.ogg`, `.opus`, `.wav`.
- A staged tree is stable only after two identical fingerprints separated by `STAGING_STABILITY_SECONDS` (default 30).
- Destination: sanitized `Author/Title`, with a deterministic ` [<acquisition-id-prefix>]` suffix only when the unsuffixed destination already exists and is not this acquisition.
- Same-filesystem handoff uses atomic rename.
- Cross-filesystem handoff copies to hidden `.importing-<acquisitionId>`, verifies relative paths/sizes/content hashes, atomically renames the hidden tree, then removes staging.
- Never merge into a pre-existing unrelated directory and never expose the hidden temporary tree to ABS.
- Trigger `POST /api/libraries/:id/scan` with the gateway’s ABS service token.
- Resolve by exact final path first; otherwise require the unique evidence score specified in Plan 3. Title-only is never sufficient.
- A tie, sub-threshold match, or timeout becomes `needs_attention`; never guess.

## Deployment defaults

- Reverse proxy and public client share one HTTPS origin.
- Proxy `/acquisition-api/` to the gateway without stripping the URI prefix.
- Gateway port: 8080 internal only.
- No direct public Librarr, Decypharr, SQLite, staging, or library-root exposure is added by this work.
- Gateway mounts staging and only the explicitly mapped ABS book-library roots read/write.
- Gateway container drops Linux capabilities and uses `no-new-privileges`.
- SQLite/config are backed up; staging is disposable; ABS media remains authoritative.
- Production enablement occurs only after a disposable ABS library passes the full import and restart tests.

## Android defaults

- Minimum SDK 26; compile and target SDK 35.
- Development/debug application suffix `.debug`; production application ID stays exact.
- Secure session uses AndroidX Security encrypted preferences behind a Capacitor plugin.
- Store server URL, connection identity, access token, and refresh token only in secure storage. Do not put tokens in React persistence, logs, player state, deep links, analytics, or crash text.
- First vertical slice may use HTML audio. Plan 6 replaces it with the foreground native player.
- ABS progress sync interval while playing: 15 seconds, plus pause/seek/background/close boundaries.
- Download default is Wi-Fi only; opt-out belongs in mobile settings.
- No production signing key is generated or committed. CI reads the four keystore environment variables specified in Plan 8.

## What to do when external inputs are absent

| Missing input | Autonomous action |
|---|---|
| ABS/Librarr credentials | Use fake adapters; complete deterministic and disposable integration tests |
| Droplet hostname/path | Keep placeholders in `.env.example` and proxy examples |
| Production library IDs/paths | Require explicit env mapping; use `lib-test` and disposable paths in tests |
| Android device/emulator | Build, unit-test, and instrument-test where available; record physical smoke test as deferred |
| Release keystore | Build debug APK; validate release configuration without signing/publishing |
| Provider/downloader availability | Test the Librarr contract with fixtures/fake server; do not bypass Librarr |

