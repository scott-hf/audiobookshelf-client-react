# Mobile Acquisition Implementation Status

- Started: 2026-08-24T10:19:02Z
- Baseline: master @ ff3274f3291735dd857adbff4dac5f09991790ce
- Branch: feature/mobile-acquisition-stack
- Current commit: see `git log -1` (t400 head)

## Completed

| Plan/task | Commit | Verification |
|---|---|---|
| WI-1496 t100: branch + import handoff docs + baseline checks | docs: import mobile acquisition handoff package (a8e699c5) | see Gates below |
| Gateway foundation plan, Task 1: workspace + contract package | feat: add acquisition workspace contract (3b854398) | `corepack pnpm --filter @abs/acquisition-contract test` — 2/2 pass |
| Gateway foundation plan, Task 2: typed acquisition client | feat: add typed acquisition client (b756787a) | `corepack pnpm --filter @abs/acquisition-client test` — 1/1 pass, typecheck clean |
| Gateway foundation plan, Task 3: validated gateway config | feat: validate acquisition gateway configuration (ea8f821b) | `corepack pnpm --filter @abs/acquisition-gateway test -- src/config.test.ts` — 1/1 pass |
| Gateway foundation plan, Task 4: SQLite migrations + repositories | feat: persist gateway acquisition state (5aed7283) | `corepack pnpm --filter @abs/acquisition-gateway test -- src/db/database.test.ts` — 5/5 pass; better-sqlite3 native binding verified working on node v24.15.0/Windows (prebuilt binary, no source compile needed on host) |
| Gateway foundation plan, Task 5: ABS auth + authenticated /status | feat: authenticate gateway through audiobookshelf (873b694e) | `corepack pnpm --filter @abs/acquisition-gateway test` — 16/16 pass (auth: 7, config: 1, db: 5, status route: 3); typecheck clean |
| Gateway foundation plan, Task 6: Dockerfile + CI wiring | ci: build acquisition gateway container (f7ed4247) | `docker build -f services/acquisition-gateway/Dockerfile -t acquisition-gateway:test .` succeeded; `docker run --rm acquisition-gateway:test node dist/main.js --help` exit 0; runtime smoke test with real env vars confirmed Fastify actually listens (`"Server listening at http://127.0.0.1:8080"` in container logs) |

## Gates

| Gate | Result | Evidence |
|---|---|---|
| **Gate 1 (mandatory gateway tracer bullet)** | **PASS** | All four required commands exit 0: `corepack pnpm --filter @abs/acquisition-contract test` (2 tests), `corepack pnpm --filter @abs/acquisition-client test` (1 test), `corepack pnpm --filter @abs/acquisition-gateway test` (16 tests), and workspace typecheck. The literal `corepack pnpm typecheck:workspace` fails on this machine for the same bare-`pnpm`-not-on-PATH reason `check` did in t100 (its script body shells out to `pnpm -r`); ran the equivalent `corepack pnpm -r --if-present typecheck` directly instead — exit 0, all 3 packages (`acquisition-contract`, `acquisition-client`, `acquisition-gateway`) report `Done`. |
| `corepack pnpm install` | PASS | Installed cleanly, postinstall (`sync-pdfjs-vendor.mjs`, `sync-unrar-wasm.mjs`) ran, `Done in 14.5s using pnpm v10.33.0`. Warning only: "Ignored build scripts: @parcel/watcher@2.5.6, @swc/core@1.15.33, @tailwindcss/oxide@4.1.8, cypress@15.9.0, unrs-resolver@1.11.1" (pre-existing pnpm behavior, not run). |
| `corepack pnpm check` (as a single command) | ENV ISSUE, not a code failure | `check` script runs `pnpm lint && pnpm typecheck && pnpm find-hardcoded-strings` internally using the bare `pnpm` binary. Since `pnpm` is not on this machine's PATH (only `corepack pnpm` is), the nested invocation fails immediately: `'pnpm' is not recognized as an internal or external command... ELIFECYCLE Command failed with exit code 1`. This is an environment PATH quirk, not a lint/type/string failure — see the three sub-checks below, run individually via `corepack pnpm <script>`, which is the direct equivalent and all passed. |
| `corepack pnpm lint` (`eslint .`) | PASS | Exit 0, no findings printed. |
| `corepack pnpm typecheck` (`tsc --noEmit`) | PASS | Exit 0, no output. |
| `corepack pnpm find-hardcoded-strings` | PASS | Output: `find-hardcoded-strings — 0 findings in 0 files` / `Summary: 0 findings | 0 with suggested keys | 0 need new keys`. Note: "0 files" scanned — not yet confirmed whether this is expected scope (e.g. scans only a specific dir/diff) or a script-scope gap; not investigated further this task (see Gaps). |

No pre-existing failures found in this baseline run of lint/typecheck/find-hardcoded-strings.

## Deviations and decisions

- Ran `check`'s three constituent scripts individually via `corepack pnpm lint` / `corepack pnpm typecheck` / `corepack pnpm find-hardcoded-strings` instead of the combined `corepack pnpm check`, because the combined script's internal `pnpm lint && pnpm typecheck && ...` chain calls the bare `pnpm` binary, which is not on PATH on this machine (only `corepack pnpm` is per the environment notes). This is equivalent verification coverage; each sub-check's actual exit code and output is recorded above.
- **`.gitignore` fix (Task 1, folded into that commit):** the root `.gitignore` only ignored `/node_modules` (anchored to repo root), so `git add packages/acquisition-contract` initially staged that package's `node_modules/` (864 files). Caught before pushing/reporting; `git reset --soft` undone, added a plain `node_modules/` line to `.gitignore`, and re-committed clean. No follow-up action needed, but worth knowing this repo's `.gitignore` previously had this gap for any new nested package.
- **better-sqlite3 build approval:** pnpm 10's default security policy blocks new deps' install/build scripts. Added `"pnpm": { "onlyBuiltDependencies": ["better-sqlite3"] }` to the root `package.json` so its native addon builds non-interactively (`pnpm approve-builds` is a TUI, unusable in this session).
- **Gateway module system: CommonJS, not ESM.** The plan's file map implies TS throughout; using `"module": "NodeNext"` (as `packages/*` semantically imply) requires explicit `.js` extensions on every relative import and tripped `TS2835` repeatedly. Switched `services/acquisition-gateway` to `"module": "CommonJS"` / `"moduleResolution": "Node10"` and dropped `"type": "module"` from its `package.json` — simpler, and better-sqlite3/fastify/pino all support CJS natively.
- **Task 5 status route `librarr` reachability check is a placeholder liveness probe** (any response < 500 from `LIBRARR_INTERNAL_URL` root = "reachable"), not validated against Librarr's actual health endpoint — the real endpoint should be confirmed and wired in the "Librarr acquisition flow" plan (next in Phase 1 sequence per the runbook).
- **Task 6 Dockerfile deviates from the plan's literal snippet in three ways, all load-bearing (verified via actual `docker build`/`docker run`):**
  1. Added `RUN apk add --no-cache python3 make g++` before install — better-sqlite3 has no prebuilt binary for linux-musl (Alpine), so it must compile from source; without build tools the image fails at `node-gyp rebuild` with "find Python" errors. This is a container-only issue (the Windows host has a working prebuilt binary — see Task 4 evidence above) and is a base-image fix, not a DB-engine swap, so it does not trigger the "STOP and report blocked" constraint.
  2. Added `--ignore-scripts` to the filtered `pnpm install`, followed by an explicit `pnpm rebuild better-sqlite3` — the repo root's own `postinstall` (Next.js pdfjs/unrar vendor sync) runs on every `pnpm install` regardless of `--filter`, and its source deps aren't part of a gateway-only filtered install, so it crashed with `MODULE_NOT_FOUND`.
  3. Runtime stage copies `/repo/node_modules` (whole workspace virtual store) plus `services/acquisition-gateway/{dist,node_modules,package.json}` preserving the original relative path depth, rather than flattening to `/app`. pnpm's workspace `node_modules` are symlinks into `node_modules/.pnpm`; flattening leaves the symlinks dangling (`Cannot find module 'pino'` at runtime, reproduced). Tried `pnpm deploy` (the documented fix) first — its non-legacy mode refuses without `inject-workspace-packages=true`, and `--legacy` mode re-resolves the *entire* workspace including the root Next app's git-hosted `foliate-js` dependency, which needs `git` (absent in the Alpine build stage) and network access. Reverted to the structure-preserving copy instead.
  - **Known cost of fix #3:** the final image is ~1.16GB (includes the whole monorepo's resolved `node_modules/.pnpm`, e.g. Next/React/Cypress, not just the gateway's actual runtime deps). Functionally correct and passes the plan's stated acceptance ("image builds; entry point starts... without a missing-module error" — verified beyond that with an actual env-configured run showing Fastify's "Server listening" log). Trimming this (proper `pnpm deploy` with `inject-workspace-packages=true`, or vendoring/removing the root's git dependency from the build context) is a follow-up, not done this task.

| Librarr acquisition flow plan (WI-1496 t300), Task 1: adapter locked to captured fixtures | feat: adapt Librarr audiobook API | `corepack pnpm --filter @abs/acquisition-gateway test -- src/adapters/librarrClient.test.ts` — 6/6 pass |
| Librarr acquisition flow plan, Task 2: opaque release snapshots | feat: issue opaque acquisition search results | `corepack pnpm --filter @abs/acquisition-gateway test -- src/services/searchService.test.ts` — 4/4 pass |
| Librarr acquisition flow plan, Task 3: idempotent submission + tracking key | feat: submit exact Librarr releases idempotently | `corepack pnpm --filter @abs/acquisition-gateway test -- src/services/acquisitionService.test.ts` — 9/9 pass, incl. concurrent-idempotency |
| Librarr acquisition flow plan, Task 4: reconciler + stall policy | feat: reconcile Librarr acquisition progress | `corepack pnpm --filter @abs/acquisition-gateway test -- src/domain/statusNormalization.test.ts src/services/reconciler.test.ts` — 19/19 pass |
| Librarr acquisition flow plan, Task 5: retry/cancel/SSE queue lifecycle | feat: expose acquisition queue lifecycle | `corepack pnpm --filter @abs/acquisition-gateway test -- src/routes/acquisitions.test.ts src/routes/events.test.ts` — 8/8 pass |

## Gate 2 (Librarr acquisition flow, WI-1496 t300)

| Check | Result | Evidence |
|---|---|---|
| Full gateway suite | PASS | `corepack pnpm --filter @abs/acquisition-gateway test` — 11 files, 62/62 pass, including the concurrent-idempotency test (`Promise.all` of two `create()` calls with the same idempotencyKey -> same acquisition id, `librarr.submitAudiobook` called exactly once) |
| Contract + client suites | PASS | `corepack pnpm --filter @abs/acquisition-contract test` 2/2; `corepack pnpm --filter @abs/acquisition-client test` 1/1 |
| Workspace typecheck | PASS | `corepack pnpm -r --if-present typecheck` — contract/client/gateway all `Done` |
| Lint | PASS | `corepack pnpm lint` — 0 errors (1 pre-existing unrelated warning in `main.ts`, not introduced this task) |
| Fixture-to-source diff | Confirmed by direct citation (not a mechanical diff -- see below) | `test/fixtures/librarr/search-audiobooks.json` and `downloads.json` field names/shapes were hand-built directly from `work/librarr @ 1b86eb1` `internal/models/book.go:7-63` (SearchResult, incl. `abb_url` line 59), `internal/models/book.go:188-220` (DownloadRequest / DownloadStatus), and `internal/api/download.go:105-180` (torrent submit response `{success,title,error,[warning],[hash]}`); the AudioBookBay fixture entry (source `"audiobook"`, only `abb_url`, no hash/magnet) matches `internal/search/audiobookbay.go:125-133` exactly (`Source:"audiobook"`, no `MediaType`/`InfoHash` set) |

Corrections applied per this item's base instructions (all verified against `work/librarr @ 1b86eb1`, not the stale `G:\tools\ABS\librarr`/`docs/handoff/reference/librarr` copies):
- Torrent requestability accepts `info_hash` OR magnet BTIH OR `abb_url` (AudioBookBay carries only `abb_url` at search time); NZB is never requestable (no SABnzbd in this deployment) -- `src/domain/releaseIdentity.ts` `isRequestable()`.
- Tracking-key precedence submit-`hash` > `job_id` > `nzo_id` > search-result `info_hash`, never title -- `src/domain/librarrTrackingKey.ts`.
- Reconciler stall policy: 0 bytes/0% progress for `STALL_TIMEOUT_SECONDS` (default 1800) -> `failed`, retryable -- `src/services/reconciler.ts`.
- Cancel/retry: `DELETE /api/downloads/torrent/{hash}` / `DELETE /api/downloads/novel/{jobID}`; `POST /api/downloads/jobs/{id}/retry` used ONLY for `job:` (direct-download) tracking keys -- `torrent:`/`nzb:` retry resubmits the persisted snapshot instead -- `src/services/acquisitionService.ts`.
- `checkLibrarrReachable` now calls the real `GET /api/health` with `x-api-key` and checks `status === "ok"` (`internal/api/health.go:29-63`), replacing the t200 placeholder.
- `packages/acquisition-contract` now has a real CommonJS build step (`tsc -p tsconfig.build.json` -> `dist/`), since `routes/search.ts` and `routes/acquisitions.ts` now do runtime `.parse()` against its schemas; `main`/`exports` point at `dist/index.js`, and the gateway Dockerfile builds it before the gateway build and copies its `dist/` + `package.json` into the runtime stage (the workspace symlink target needed to exist there too). Added `dist/` to `.gitignore` and to `eslint.config.js`'s `ignores` (was `dist/`, only matched the repo root; changed to also include `**/dist/`).

## Gate 3 (import handoff + ABS resolution, WI-1496 t400)

Correlation strategy pinned FIRST in `docs/handoff/correlation-note.md` (written before any
implementation), then Plan 3 tasks 1-6 implemented against it.

| Plan/task | Commit | Verification |
|---|---|---|
| Correlation note (written first, authoritative over the plan doc) | docs: pin acquisition-to-staged-tree correlation strategy (e2c7fc51) | source-cited against `work/librarr @ 1b86eb1` and the reference-only ABS server checkout |
| Import handoff plan, Task 1: path confinement + destinations | feat: confine acquisition filesystem paths (f796fa8c) | `npx vitest run src/domain/safePath.test.ts` — 19/19 pass |
| Import handoff plan, Task 2: staged-tree stability | feat: validate staged audiobook output (ded66fa8) | `npx vitest run src/services/stagingInspector.test.ts` — 9/9 pass |
| Import handoff plan, Task 3: atomic / verified handoff | feat: hand off staged audiobooks safely (5d9e2f49) | `npx vitest run src/services/fileHandoff.test.ts` — 11/11 pass (mocked EXDEV + real-filesystem copy path) |
| Import handoff plan, Task 4: ABS scan + item queries | feat: add Audiobookshelf import adapter (de877dd3) | `npx vitest run src/adapters/absAdminClient.test.ts` — 9/9 pass |
| Import handoff plan, Task 5: single-item resolution | feat: resolve imported Audiobookshelf items (21af31e9) | `npx vitest run src/services/importResolver.test.ts` — 10/10 pass |
| Import handoff plan, Task 6: coordinator + compose e2e | feat: complete restart-safe acquisition imports | full suite + docker compose journey, below |

| Check | Result | Evidence |
|---|---|---|
| Full gateway suite | PASS | `npx vitest run` in `services/acquisition-gateway` — **18 files, 143/143 pass** |
| Disposable compose e2e journey | PASS | `docker compose -f deploy/acquisition/docker-compose.test.yml up --build --abort-on-container-exit gateway-e2e` -> `test/e2e/importJourney.test.ts (6 tests)`, `Test Files 1 passed (1)`, `Tests 6 passed (6)`, `gateway-e2e-1 exited with code 0` |
| Root lint | PASS | `corepack pnpm lint` — exit 0, no findings (the pre-existing `main.ts` unused-disable warning was removed this task) |
| Root typecheck | PASS | `corepack pnpm typecheck` — exit 0 (fixed a pre-existing `loadConfig(input: NodeJS.ProcessEnv)` signature that made every test's explicit env literal a root-typecheck error) |
| `corepack pnpm find-hardcoded-strings` | PASS (scope still unconfirmed) | `0 findings in 0 files` — same carried-over scope question as t100/t300 |

### processing -> scanning -> available now implemented (closes the t300 follow-ups)

`src/services/importCoordinator.ts` owns the whole post-download pipeline and is driven each
reconcile pass by `Reconciler.advanceImports()`. `AcquisitionService.retry()` delegates any
failure whose `lastSuccessfulStage` is an import stage to the coordinator, so an import
failure never re-submits to Librarr. The t300 "unreachable `scanning` retry branch" and the
"ABS scan never triggered" follow-ups are both resolved.

### Corrections applied on top of the handoff package (verified against live source)

- **The plan document's `<Author>/<Title>` staging assumption AND FND-00411's `<Title>/<Author>`
  observation are both partly wrong, and neither is usable.** `internal/organize/pipeline.go:124`
  builds `AUDIOBOOK_DIR/<author>/<title>/`, but `internal/download/watcher.go:487-499` derives
  those two arguments from a positional `" - "` split of the TORRENT NAME (`parts[0]` is
  assumed to be the author). AudioBookBay names are frequently `Title - Author`, which produces
  FND-00411's observed transposed tree. Conclusion: the staged path is a function of an
  unreliable string heuristic and must never be inferred. Recorded as FND-00449.
- Correlation is therefore Librarr's own library row: `source_id` (== the torrent hash,
  `watcher.go:562`) -> `file_path` (`internal/models/book.go:104`, served by
  `GET /api/library/audiobooks`' local fallback, `internal/api/library_external.go:56-64`).
  Fallback is a new-tree stability scan matching metadata against BOTH path segments in either
  order; anything ambiguous is `needs_attention`.
- Cleanup after a confirmed import deletes the staged tree AND
  `DELETE /api/library/audiobook/{id}` (`internal/api/router.go:311`) — both mandatory, because
  a leftover tree is re-registered by Librarr's startup scanner (FND-00414) and a leftover row
  blocks re-acquisition via `in_library` dedupe.
- ABS scan trigger verified as `POST /api/libraries/:id/scan` (`server/routers/ApiRouter.js:91`);
  item shape taken from `LibraryItem.toOldJSONMinified()` (`server/models/LibraryItem.js:1012`)
  and `Book.oldMetadataToJSONMinified()` (`server/models/Book.js:587`) — `addedAt` is epoch ms,
  not an ISO string.
- The ABS scan is asynchronous, so "item not indexed yet" is a bounded WAIT in `scanning`
  (reusing `STALL_TIMEOUT_SECONDS`), not an immediate failure; the scan POST itself lives in
  the `scanning` stage so a retry re-scans without redoing the handoff.
- Import resolution filters candidates by library as a HARD gate, never a scoring preference —
  an item in another library can never be this import regardless of metadata score.
- Final-tree modes default to `preserve` (`FINAL_TREE_MODE`), matching FND-00413's 0644/0755.

## Known blockers / external checks

- `corepack pnpm find-hardcoded-strings` reports "0 files" scanned — scope not investigated this task; confirm expected behavior before relying on it as a real gate in a later task.
- `pnpm check` (and `pnpm typecheck:workspace`/`pnpm test:workspace` at the root) will keep failing as a single command on this machine until either `pnpm` is added to PATH or the scripts are changed to invoke `pnpm run` sub-scripts explicitly; flagged for awareness, not fixed here (out of this task's scope). Always run the underlying `corepack pnpm ...` command directly instead.
- Acquisition gateway Docker image is ~1.16GB — see Task 6 deviation note above. Not a functional blocker for Gate 1, but should be revisited before any real deployment.
- RESOLVED in t300: `checkLibrarrReachable` now calls the real `GET /api/health`; `packages/acquisition-contract` now has a real CommonJS build step. See the Gate 2 section above.
- RESOLVED in t400: the `processing` -> `staged` -> `importing` -> `scanning` -> `available`
  pipeline and the ABS scan trigger are implemented (`src/services/importCoordinator.ts`), and
  `AcquisitionService.retry()`'s import-stage branch is now reachable and tested. Superseded
  items kept below for history:
- (superseded by t400) the `available` state (post-scan, item visible in ABS) and the `scanning` stage (triggering an ABS library scan) are not implemented anywhere yet -- the reconciler only reaches `processing` for a Librarr `completed`/`importing` status and then leaves the row alone (Librarr's own `/api/downloads` entry drops off once its job finishes, which the reconciler treats as expected, not a signal to promote further). A later task needs to add the ABS-scan-triggering step and the `processing` -> `scanning` -> `available` transition.
- (superseded by t400) `AcquisitionService.retry()`'s `lastSuccessfulStage === 'scanning'` branch (skip re-calling Librarr, just reset to `scanning`) is written defensively but unreachable/untested today since nothing yet sets that stage -- verify it once the scanning stage above exists.
- t300 follow-up not yet done: reconciler's `historyRetentionSeconds` cleanup and `SearchRepository.deleteExpiredExcept` are implemented and unit-covered only indirectly (no dedicated retention/cleanup test) -- add one before relying on it in production.

## Security review

- No `server.url`, production hostname, token, key, or keystore was added. Only markdown docs (handoff copy, README, this status file) were added; no source/config changed.

## Exact next task

**t400 is complete.** Next is Plan 4 in the runbook sequence (React web acquisition UI /
Gate 4). Before leaning on `corepack pnpm check` as a real Gate 4 gate, resolve the
`find-hardcoded-strings` "0 files" scope question carried since t100.

### Historical (t300 — already done)

Gate 2 (Librarr acquisition flow) is implemented and all tests pass (see Gate 2 section above), but **the working tree has NOT been committed yet** -- the worker that did this implementation hit its context-rotation threshold immediately after finishing verification. Next worker: review the uncommitted diff, then create the 5 per-task commits using the plan's own commit messages (task boundaries below), in order:
1. `feat: adapt Librarr audiobook API` -- `src/adapters/`, `test/fixtures/librarr/`, plus the `status.ts` real-health-check fix (carried from t200 HANDOFF, same task).
2. `feat: issue opaque acquisition search results` -- `src/domain/releaseIdentity.ts`, `src/services/searchService.ts`, `src/routes/search.ts`, contract's `SearchRelease`/`SearchResponse`/`SearchQuery` additions, client's `searchAudiobooks`.
3. `feat: submit exact Librarr releases idempotently` -- `src/domain/librarrTrackingKey.ts`, `src/services/acquisitionService.ts` (create only), `src/routes/acquisitions.ts` (POST/GET only), DB migration 2 (`tracking_key`/`stalled_since`), repo changes, PLUS the contract package's build-step conversion (`tsconfig.build.json`, `package.json` main/exports, Dockerfile build-order + runtime-stage copy, `.gitignore`/`eslint.config.js` `dist/` fixes) since that conversion's trigger condition is this task's first runtime `.parse()` call.
4. `feat: reconcile Librarr acquisition progress` -- `src/domain/statusNormalization.ts`, `src/services/reconciler.ts`, `app.ts` reconciler wiring, config's `STALL_TIMEOUT_SECONDS`/`RECONCILE_INTERVAL_MS`/`HISTORY_RETENTION_SECONDS`.
5. `feat: expose acquisition queue lifecycle` -- `src/events/`, `src/routes/events.ts`, `acquisitionService.retry()`/`cancel()`, `routes/acquisitions.ts` retry/cancel routes, contract's `AcquisitionEvent`, client's remaining methods.

These boundaries overlap in a few files (`app.ts`, `acquisitions.ts`, contract's `index.ts`, `acquisitionRepository.ts`) since they were written together for a working end state -- splitting the diff by hunk across commits 2-5 is acceptable if exact per-file boundaries aren't practical; do not spend excess effort forcing a clean split. Re-run `corepack pnpm --filter @abs/acquisition-gateway test` (62/62 expected), `corepack pnpm -r --if-present typecheck`, and `corepack pnpm lint` after committing to confirm nothing was lost in the split, then proceed to Plan 3 in the runbook sequence.
