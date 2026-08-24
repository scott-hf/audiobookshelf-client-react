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

## Gate 4 (React web acquisition UI, WI-1496 t500) -- CLOSED, all 6 tasks done (worker-7 continuation 3)

### worker-5 continuation (2026-08-24): Tasks 1-3 committed with real runtime evidence, Task 4 done

**Real bug fixed first (Cypress binary now installed):** `SideRailContent.tsx` (already using
`useLibraryOptional` before this task) transitively imports `src/app/actions/libraryActions.ts`
(a `'use server'` action) -> `src/lib/api.ts`, which has a top-level `import { cookies, headers }
from 'next/headers'`. Real Next builds split `'use server'` files into a server layer and a
client-safe RPC stub; Cypress's component-testing webpack bundle does not run that split, so it
fails to compile with "You're importing a module that depends on next/headers... but you are
using it in the Pages Router." Root-caused two things, NOT a Cypress config workaround alone:
1. `next-swc-loader`'s check is a static-source scan of the literal `next/headers` import text in
   `api.ts` -- a plain `resolve.alias` on `next/headers` itself does NOT work around it (verified
   empirically). A plain `resolve.alias` keyed on the importing file
   (`@/app/actions/libraryActions`) ALSO does not reliably win: Next's own generated Cypress
   webpack config already contributes a broader `'@'` alias earlier in iteration order, which
   always matches first regardless of object-key order in our own config. Fix:
   `NormalModuleReplacementPlugin` (from `next/dist/compiled/webpack/webpack`, since this repo has
   no direct `webpack` devDependency) taps `beforeResolve`, which runs before alias resolution, so
   it reliably replaces `@/app/actions/libraryActions` with `cypress/support/mocks/libraryActions.ts`
   (stub exports, throw loudly if ever actually called -- no test mounts a real `LibraryProvider`)
   for the CT bundle only. See `cypress.config.ts` and `cypress/support/mocks/libraryActions.ts`.
2. Once compiling, `SideRailContent`'s first-ever mount crashed on `isLibraryIssuesPage(pathname)`
   with `Cannot read properties of null (reading 'endsWith')` -- `usePathname()` can legitimately
   return `null` outside a full app-router context, and this pre-existing helper never guarded for
   it. Hardened `src/hooks/useLibraryRouteGuard.ts`'s `isLibraryIssuesPage` to
   `pathname?.endsWith('/issues') ?? false`.
Confirmed both are genuinely pre-existing (not introduced by this feature): `git stash` +
re-running `cypress/tests/components/widgets/ChaptersTable.cy.tsx` (an unrelated pre-existing spec)
reproduces its own unrelated 1-test breakpoint-timing failure identically stashed vs. unstashed --
that one is a pre-existing flake, left alone (out of scope, not caused by this task).

All 3 Tasks 1-3 specs green for real:
`corepack pnpm test:spec "cypress/tests/components/acquisition/**/*.cy.tsx"` -> 8/8 pass
(AcquisitionProvider 2/2, DiscoverClient 3/3, SideRailAcquisition 3/3). Full existing component
suite also re-run (`cypress/tests/components/**/*.cy.tsx`, 638 tests, 31 specs): 637/638 pass, the
1 failure being the pre-existing ChaptersTable flake above, confirmed unrelated.

Also fixed a real DiscoverClient.cy.tsx authoring bug found while getting it green: a module-level
`cy.stub()` call outside any `it()`/`beforeEach` (`cy.stub()` cannot run outside a running test) --
converted to a `createMockAcquisitionContext()` factory called inside `mountDiscover`.

Committed Tasks 1-3 (plan's own messages, `git log --oneline -5` in this repo confirms):
`feat: provide web acquisition state` (e5a0ad77), `feat: add acquisition navigation` (56889f46),
`feat: add audiobook discovery screen` (c3baa744).

**Task 4 (acquisition queue) implemented and committed:**
`src/components/acquisition/AcquisitionRow.tsx`, `src/app/(main)/library/[library]/acquisition-queue/{page.tsx,AcquisitionQueueClient.tsx}`,
test `cypress/tests/components/acquisition/AcquisitionQueueClient.cy.tsx` (8/8 pass). Follows
`ReleaseCard.tsx`'s pattern exactly (progress clamped `Math.min(100, Math.max(0, p))`, `canOpen`/
`canRetry`/`canCancel` derived from the real 11-value `AcquisitionState` enum, not the plan's
shorter illustrative list). Uses `useAcquisition().getQueue`/`ensureQueueLoaded`/`applyAcquisition`
(no second client/context built) plus an injectable `api` prop (`AcquisitionQueueApi`, mirroring
`DiscoverApi`) for `acquisitionClient.retryAcquisition`/`cancelAcquisition` --
**note both take only `(acquisitionId)`, no `libraryId` param** (verified against
`packages/acquisition-client/src/index.ts:51-52`, diverges from the plan's illustrative signature).

**Real bug found + fixed while wiring Task 4, unrelated to Task 4 itself:**
`src/hooks/useLibraryRouteGuard.ts`'s `LIBRARY_BOOK_PAGES` allowlist never included `'discover'` or
`'acquisition-queue'` (added in Tasks 2/3), so `useLibraryRouteGuard()` (called unconditionally by
`LibraryLayoutWrapper.tsx`, which wraps every real `/library/[library]/*` route) would have
`router.replace`'d a real browser visit to `/library/{id}/discover` straight back to
`/library/{id}` before the page ever rendered -- invisible to the Cypress component tests since
none of them mount `LibraryLayoutWrapper`. Added both page names to `LIBRARY_BOOK_PAGES`. This
would have silently broken Task 6's real browser journey test had it shipped unfixed.

Also caught and fixed a test-authoring bug in the new queue spec itself while writing it: calling
`cy.stub().as('retry')` on both a fallback default AND a per-test override with the same alias
name repoints `@retry` at whichever stub called `.as()` chronologically last (JS evaluates call
arguments, including the override's `.as('retry')`, before the function body runs) -- NOT at the
stub actually wired into the component via object-spread precedence. Fixed by aliasing only once
(`api.retryAcquisition ?? cy.stub().as('retry')`), never a doubled alias.

Verification this task: `corepack pnpm typecheck` exit 0, `corepack pnpm lint` exit 0 (no
findings), `corepack pnpm find-hardcoded-strings` `0 findings in 0 files`,
`corepack pnpm test:spec "cypress/tests/components/acquisition/AcquisitionQueueClient.cy.tsx"`
8/8 pass.

### Original t500 kickoff notes (superseded above where they conflict)

`find-hardcoded-strings` "0 files" scope question resolved (t500, direct verification): it means
"0 files WITH findings", not "0 files scanned" -- the scanner genuinely covers all 686 `.ts`/`.tsx`
files under `src/`. Not a gap; treat it as a real gate.

**Not committed yet** -- working tree has Tasks 1-3 uncommitted (context-rotation boundary hit
mid-plan). Next worker: review the diff, then commit using the plan's own messages for tasks 1-3
(`docs/handoff/plans/2026-08-24-react-web-acquisition-implementation-plan.md`), then continue with
Tasks 4-6.

| Plan/task | Status | Verification |
|---|---|---|
| Task 1: browser client + provider | DONE (uncommitted) | typecheck/lint/find-hardcoded-strings clean (see below); Cypress runtime NOT run (see gap) |
| Task 2: conditional Discover navigation | DONE (uncommitted) | same |
| Task 3: Discover search + confirmation | DONE (uncommitted) | same |
| Task 4: acquisition queue | NOT STARTED | -- |
| Task 5: settings diagnostics | NOT STARTED | -- |
| Task 6: full browser journey (e2e) | NOT STARTED | -- |

### Real API shapes used (plan's snippets are illustrative only, do not follow them literally)

The plan document's Task 1/6 code snippets describe a `/libraries/{id}/...` path-based API with a
`{ acquisitions: [] }` wrapper and a `cancel` POST route. The REAL, already-implemented gateway
(`services/acquisition-gateway/src/routes/*.ts`, built in t300/t400) is query-param based and was
followed instead, verified by direct route/client source citation:
- `GET /acquisition-api/v1/status` -> `{ version, ready, librarr: {reachable}, staging: {ready}, libraries: [{id, enabled}] }`
- `GET /acquisition-api/v1/search/audiobooks?libraryId=&q=` -> `SearchResponse {searchSessionId, results: SearchRelease[]}`
- `POST /acquisition-api/v1/acquisitions?libraryId=` (body `CreateAcquisitionBody`) -> `Acquisition`
- `GET /acquisition-api/v1/acquisitions?libraryId=` -> `Acquisition[]` (a bare array, NOT `{acquisitions: [...]}`)
- `GET /acquisition-api/v1/acquisitions/:id` -> `Acquisition`
- `POST /acquisition-api/v1/acquisitions/:id/retry` -> `Acquisition`
- `DELETE /acquisition-api/v1/acquisitions/:id` (cancel, not a `/cancel` POST) -> `Acquisition`
- `GET /acquisition-api/v1/events` -> SSE, named events `acquisition.created`/`acquisition.updated`, payload only carries `acquisitionId` (no `libraryId`)
- Client singleton `packages/acquisition-client/src/index.ts` (`createAcquisitionClient`) already implements all of the above; `src/lib/acquisition.ts` wraps it with a session-refresh-on-401 retry, not a fresh client.

### Auth: browser cookies are enough, no bearer token wiring needed

`services/acquisition-gateway/src/auth/absAuth.ts` `extractAccessToken()` reads the `access_token`
httpOnly cookie directly server-side (bearer header OR cookie) -- the browser's automatic
`credentials: 'include'` cookie send is sufficient; no `getAccessToken` callback was wired into
`createAcquisitionClient`. On a 401, `src/lib/acquisition.ts` calls the existing
`POST /internal-api/refresh` route (`accept: application/json` header -> JSON `{success}` instead
of a redirect, sets new cookies) once, then retries the original call once. ABS session state is
never touched on gateway failure.

### New workspace wiring (Task 1, was missing before this task)

Root `package.json` had NO dependency on `@abs/acquisition-client`/`@abs/acquisition-contract`
before this task despite both packages existing since Gate 1/2 -- added
`"@abs/acquisition-client": "workspace:*"` and `"@abs/acquisition-contract": "workspace:*"`.
`@abs/acquisition-client`'s `main` points at raw `.ts` (no build step) so it also needed adding to
`next.config.ts` `transpilePackages`. The production `Dockerfile`'s `build-client` stage only
copied `package.json`/`pnpm-lock.yaml`/`.npmrc`/`scripts` before `pnpm install --frozen-lockfile`
-- since this is a pnpm workspace, that install would have failed without `pnpm-workspace.yaml`
and `packages/` also present; both are now copied first (plan's Task 1 Dockerfile snippet,
verified necessary by reading the existing stage, NOT rebuilt/tested this task -- see gaps).
Ran `corepack pnpm install` after the `package.json` edit -- linked cleanly, `Done in 1.7s`.

### Component test convention deviation (deliberate, verified against the existing suite)

The plan's test snippets use `cy.findByRole`/`cy.findByLabelText` (`@testing-library/cypress`).
That package is NOT installed anywhere in this repo (confirmed: zero references in
`package.json`/`pnpm-lock.yaml`/existing `cypress/tests/**`). The repo's actual, consistently-used
convention (see `cypress/tests/components/ui/Btn.cy.tsx`, `.../app/UserAppBarNav.cy.tsx`) is plain
`cy.get`/`cy.contains` plus a `cy-id="..."` attribute convention (`cypress/support/commands.ts`
maps a leading `&` in a selector to `[cy-id="..."]`). Did NOT add a new devDependency (avoids an
unverified network install); wrote all three new specs using the existing convention instead,
including a `cy-id="release-card"` attribute added to `ReleaseCard.tsx` for this purpose. Also
followed the established `UserContext.Provider`/`AppRouterContext.Provider` direct-mock-context
mounting pattern from `UserAppBarNav.cy.tsx` rather than mounting real providers that pull in
`SocketProvider`/real `EventSource` (added `export const AcquisitionContext` alongside the
existing hook, mirroring `UserContext`, specifically so tests can mock it the same way).

### Verification run this task (Tasks 1-3 only)

| Check | Result | Evidence |
|---|---|---|
| `corepack pnpm install` | PASS | `+ @abs/acquisition-client 0.1.0`, `+ @abs/acquisition-contract 0.1.0`, `Done in 1.7s` |
| `corepack pnpm typecheck` | PASS | exit 0, no output (one round-trip fix needed: `cy.stub().resolves(x).as(...)` loses the Cypress `Agent` type through Sinon's `.resolves()`; reordered to `.as(...).resolves(x)`) |
| `corepack pnpm lint` | PASS | exit 0, no findings |
| `corepack pnpm find-hardcoded-strings` | PASS | `0 findings in 0 files` (see scope note above -- this is a real clean pass, not a scope gap) |
| Cypress component test RUNTIME (`test:spec`) | NOT RUN -- environment gap | `cypress run` fails: "No version of Cypress is installed in ...\Cypress\Cache\15.9.0\Cypress" / "Please reinstall Cypress by running: cypress install". Cypress binary cache is missing/empty on this machine. Needs `corepack pnpm exec cypress install` (network fetch, not attempted -- out of budget this task) before any `test`/`test:spec`/`cy:open` command can actually execute on this machine. All three new specs (`AcquisitionProvider.cy.tsx`, `SideRailAcquisition.cy.tsx`, `DiscoverClient.cy.tsx`) are typecheck-clean and lint-clean but UNVERIFIED at runtime. |

### Gaps / open items for the next worker

1. **Cypress binary missing on this machine** -- run `corepack pnpm exec cypress install` first,
   then `corepack pnpm test:spec "cypress/tests/components/acquisition/**/*.cy.tsx"` to get real
   runtime evidence for Tasks 1-3 before trusting them, and to run Task 4/5's specs as they're
   written.
2. Tasks 4 (queue), 5 (settings diagnostics), 6 (e2e journey) are NOT STARTED. Locale keys for
   Task 4/5 (`HeaderAcquisitionQueue`, `ButtonOpenBook`, `ButtonViewQueue`,
   `MessageConfirmCancelAcquisition`, `MessageAcquisitionQueueEmpty`, `StatusAcquisition*` x11,
   `HeaderAcquisition`, `LabelGateway`, `LabelLibrarr`, `LabelStaging`, `LabelConnected`,
   `LabelNotReady`, `LabelEnabledLibraries`) were pre-added to `src/locales/en-us.json` this task
   so the next worker doesn't need to re-derive them -- verify they're still adequate once the
   actual components are written (some may need adjusting, e.g. cancel confirmation wording).
3. Task 4's `AcquisitionRow.tsx` should follow the same pattern as `ReleaseCard.tsx`: progress
   clamped via `Math.min(100, Math.max(0, p))`, `canOpen = state === 'available' && !!absItemId`,
   `canRetry = state === 'failed' && error?.retryable === true`,
   `canCancel = ['queued','submitted','downloading','processing','staged'].includes(state)` (real
   `AcquisitionState` enum is in `packages/acquisition-contract/src/index.ts` -- 11 states, not the
   plan's shorter list; `needs_attention` and `importing`/`scanning`/`available` also exist from
   Gate 3's import pipeline). Use `acquisitionClient.retryAcquisition`/`cancelAcquisition` (already
   built in `src/lib/acquisition.ts`), and `useAcquisition().ensureQueueLoaded`/`getQueue` from
   `AcquisitionContext` (already built) to back the queue page -- do not build a second client or
   context.
4. Task 5's settings page: reuse `SettingsContent` (`src/app/(main)/settings/SettingsContent.tsx`)
   and add a `HeaderAcquisition` entry to `SettingsNavItemDef`/`SETTINGS_NAV_ITEMS` in
   `src/app/(main)/settings/settingsNavItems.ts` (both are typed unions of literal `messageKey`
   strings -- extend the union, don't just add to the array). Status comes from
   `useAcquisition().status` (already loads once on mount) -- no new fetch needed.
5. Task 6 needs an actual `e2e` project added to `cypress.config.ts` (currently `component` only,
   confirmed by reading the file this task) plus `cypress/support/e2e.ts` if one doesn't exist --
   not investigated this task.
6. Dockerfile change (workspace copy) was made but NOT verified with an actual `docker build` this
   task (Task 1's plan step 4/6 build+run verification not done) -- do that before trusting the
   container still builds.
7. `AcquisitionApiError`/`formatAcquisitionError` in `src/lib/acquisition.ts` maps gateway error
   `code` values to translated messages for codes seen in `services/acquisition-gateway/src/routes/
   acquisitions.ts`/`search.ts` (`search_not_found`, `search_expired`, `release_not_found`,
   `release_not_trackable`, `library_forbidden`, `library_mismatch`, `acquisition_not_found`,
   `acquisition_not_retryable`, `acquisition_not_cancellable`, `gateway_not_ready`) -- falls back to
   a generic message for anything else (e.g. a raw 500). Not unit-tested directly this task, only
   exercised indirectly via `DiscoverClient.cy.tsx`'s error-toast test.

## Gate 4 continuation 2 (worker-6, 2026-08-24) -- Task 5 DONE and verified; Task 6 (e2e) infra built but NOT green yet; Docker re-verify NOT run

### Task 5 -- settings diagnostics page (DONE, committed, verified)

Files: `src/app/(main)/settings/acquisition/page.tsx`, `AcquisitionSettingsClient.tsx`,
`settingsNavItems.ts` (+`HeaderAcquisition` nav entry),
`cypress/tests/components/acquisition/AcquisitionSettingsClient.cy.tsx`.

**Real defect found and fixed along the way:** `AcquisitionStatusResponse` in
`packages/acquisition-client/src/index.ts` was missing `librarr: {reachable}` and
`staging: {ready}` -- the gateway's actual `/status` route
(`services/acquisition-gateway/src/routes/status.ts` `StatusResponse`) has always returned
those fields, but the browser client's type never declared them, so nothing on the frontend
could read them (needed for this task). Fixed the interface, and updated the two now-stale
literal status mocks that broke typecheck as a result (`SideRailAcquisition.cy.tsx`,
`packages/acquisition-client/src/index.test.ts`).

Evidence (all run individually this task):
- `corepack pnpm test:spec cypress/tests/components/acquisition/AcquisitionSettingsClient.cy.tsx` -- 3/3 pass.
- `corepack pnpm --filter @abs/acquisition-client test` -- 1/1 pass.
- `corepack pnpm lint` -- exit 0. `corepack pnpm typecheck` -- exit 0.
  `corepack pnpm find-hardcoded-strings` -- `0 findings in 0 files`.
- Full acquisition component suite re-run after the change (`corepack pnpm test:spec
  "cypress/tests/components/acquisition/*.cy.tsx"`, background run) -- exit 0.

Committed as `feat: show acquisition gateway diagnostics` (plan's own message).

### Task 6 -- e2e journey (infra built, NOT yet verified green; UNCOMMITTED)

Files (uncommitted, present in the working tree): `cypress.config.ts` (+`e2e` project,
baseUrl `http://localhost:3000`), `cypress/support/e2e.ts` (`cy.loginByApi()` +
`&cy-id` shorthand), `cypress/e2e/acquisition.cy.ts`, `cypress/e2e/support/fakeAbsServer.mjs`,
`cypress/fixtures/acquisition/search.json`, `cypress/fixtures/acquisition/queue-available.json`.

The plan's own e2e snippet (`cy.loginByApi()`, `cy.intercept` on `/acquisition-api/v1/*`) is
illustrative only: this repo has no real ABS backend, no gateway running by default, and no
pre-existing e2e infra of any kind (`loginByApi` did not exist -- added it as a real command
that calls the real `POST /internal-api/login` route handler). The Next server's own
server-side login/session calls (`src/lib/api.ts` `getServerBaseUrl()` -> `/login`,
`/api/authorize`, and `LibraryLayout`'s `getLibraries()` -> `/api/libraries`) run in the Node
process, not the browser, so `cy.intercept` cannot reach them -- there is no way around
standing up *something* those calls can hit. Built `fakeAbsServer.mjs`, a zero-dependency
Node `http` server implementing exactly those endpoints (login/authorize/libraries/me) with
synthetic, disposable data (single library `lib1`, one admin user) -- verified working
standalone via direct `curl` this task (`POST /login`, `GET /api/libraries` both returned the
expected shapes). `/acquisition-api/v1/*` itself stays `cy.intercept`-mocked in the spec, on
the theory that the gateway's own business logic already has real coverage (Gates 1-3,
`services/acquisition-gateway/test/e2e/importJourney.test.ts`) and this spec's job is the
React UI's click-through behavior, not re-proving the backend.

**Not yet done:** running `next dev` against `fakeAbsServer.mjs` and the `cypress run --e2e`
spec end-to-end. One real run this task got the dev server up (`HOST=localhost PORT=3333
corepack pnpm exec next dev -p 3000`, confirming the `-p` flag vs. `PORT` env split needed to
separate "Next's own listen port" from "the ABS URL Next's server code targets" actually
works -- `✓ Ready in 1362ms`) but surfaced a real bug before a single spec ran: hitting
`/login` triggered a **runaway retry loop of `GET /status` requests** (10,000+ logged in under
a second, `next-dev.log`) -- something client-side is retrying a status-shaped fetch with no
backoff when the response doesn't match what it expects. Root cause NOT yet identified (ran
out of budget mid-investigation) -- prime suspects: `getServerStatus()`
(`src/lib/api.ts` ~line 464, distinct from the acquisition gateway's own `/status`) being
polled by some component against `fakeAbsServer.mjs`'s permissive `{}` catch-all for unmatched
GET paths, in a loop with no backoff. Next worker: reproduce with `next-dev.log` open,
`grep -c "/status" `, find the caller of `getServerStatus`/whatever hits ABS `/status`
repeatedly, and either fix the caller's retry logic (if it's a real app bug worth a FND) or
give `fakeAbsServer.mjs` a real handler for that path so it stops looking like a failure worth
retrying. All processes killed (`taskkill //F //IM node.exe //T`) before this task ended --
nothing left running.

**Do not commit `cypress/e2e/**` or `cypress.config.ts` until the spec actually runs and
passes at both viewports** -- committing an e2e project that has never gone green would be
worse than not having one.

### Gate 4 continuation 3 (worker-7, 2026-08-24) -- Task 6 finished green, Docker re-verified, Gate 4 CLOSED

**Root cause of the runaway `GET /status` retry loop (found via instrumentation, not
guessing):** `next dev`/`next start` unconditionally overwrite `process.env.PORT` to match
their OWN resolved listen port
(`node_modules/next/dist/server/lib/start-server.js:296`: `process.env.PORT = port + ''`).
`src/lib/api.ts`'s `getServerBaseUrl()` builds the ABS backend target from `HOST`/`PORT`, so
once Next boots on port 3000, `PORT` always reads back as `'3000'` regardless of what was set
at shell-invocation time -- `getServerStatus()` (called from `src/proxy.ts` on every request
missing a `language` cookie) ends up fetching `http://<HOST>:3000/status`, i.e. **the Next
server's own origin**. `/status` isn't excluded by the middleware `matcher`, so that
self-fetch re-enters `proxy()`; the internal fetch carries no cookies, so `!languageCookie` is
true again, so it self-fetches `/status` again -- an unbounded self-referential HTTP flood
(confirmed via a temporary `console.trace()` + call counter in `apiRequest`, all traces
resolving to `proxy` -> `apiRequest('/status')`, never to the page render). Traced and
resolved on a scratch instance, not blind-guessed: this consumed real Windows socket buffer
capacity (`curl: Could not connect to server ... No buffer space`) until processes were
force-killed.

**Fix (test-launch-only, no real app code touched):** since `HOST` is the one env var Next
never overwrites, `cypress/e2e/support/fakeAbsServer.mjs` now binds to a distinct loopback
alias (`127.0.0.2` by default, override via `FAKE_ABS_HOST`) on the SAME port Next ends up
using (override via `FAKE_ABS_PORT`), instead of its own dedicated port. Launch pair:
```
FAKE_ABS_HOST=127.0.0.2 FAKE_ABS_PORT=3000 node cypress/e2e/support/fakeAbsServer.mjs &
HOST=127.0.0.2 corepack pnpm exec next dev -p 3000 &
```
Verified directly: `curl http://localhost:3000/login` -> `200`, exactly 2 `getServerStatus()`
calls total (one from `proxy.ts`, one from `LoginPage`), zero recursion, both PIDs stable in
`tasklist` afterward.

**Second real bug found while investigating (not the loop cause, but real):**
`fakeAbsServer.mjs`'s `/login`/`/api/authorize` responses used plain opaque strings
(`'e2e-access-token'`) as tokens. `src/lib/jwt.ts`'s `decodeJWT()` requires a genuine
3-segment `header.payload.signature` structure with a numeric `exp` claim -- a non-JWT string
decodes to `null`, which `isTokenExpired()` treats as **already expired**, so
`proxy.ts`/`apiRequest` saw every session as invalid immediately after a successful
`loginByApi()`. Added a `fakeJwt(expiresInSeconds)` helper (unsigned `alg: 'none'`
header + real `exp`/`iat` payload -- `decodeJWT` never verifies the signature, matching its
own doc comment) and used it for both access and refresh tokens.

**Third real bug found the same way:** `GET /api/items/:id` had no explicit handler, falling
to the catch-all's `200 {}`. `LibraryItemClient.tsx` reads `libraryItem.media.metadata`
directly (no optional chaining) -- `{}.media` is `undefined`, crashing with `Cannot read
properties of undefined (reading 'metadata')` on the final "Open Book" navigation. Added a
real minimal `BookMedia`/`BookMetadata`-shaped `GET /api/items/abs_e2e_item_1` handler.

All three were found by instrumenting and re-running, not by reasoning in the abstract per the
task's own guidance -- each theory was verified to actually resolve the observed symptom
before moving to the next one.

**Real green run** (`corepack pnpm exec cypress run --e2e --browser chrome --spec
cypress/e2e/acquisition.cy.ts`):
```
acquisition web journey
  √ completes search -> confirm -> acquire -> queue -> available -> Open Book (desktop) (11825ms)
  √ completes search -> confirm -> acquire -> queue -> available -> Open Book (mobile) (10889ms)

2 passing (23s)
```
Committed as `test: cover web acquisition journey` (87e88d58) -- `cypress.config.ts` (e2e
project), `cypress/support/e2e.ts`, `cypress/e2e/acquisition.cy.ts`,
`cypress/e2e/support/fakeAbsServer.mjs`, `cypress/fixtures/acquisition/{search,queue-available}.json`.

**Gate 4 acceptance part 2** (lint/typecheck/find-hardcoded-strings, run individually per the
task's own instruction -- ignore combined `pnpm check`'s unrelated PATH noise):
`corepack pnpm lint` -> `eslint .` exit 0, no output. `corepack pnpm typecheck` -> `tsc
--noEmit` exit 0, no output. `corepack pnpm find-hardcoded-strings` -> `find-hardcoded-strings
— 0 findings in 0 files`. The "0 files" scope gap noted since t100 is STILL open (the script
is scanning nothing, not confirming nothing needs a key) -- carried forward, not resolved
this task; does not block Gate 4 per the task's literal acceptance wording, but Gate 5+ work
that adds real UI strings should not treat a "0 findings" run as proof of coverage until this
is root-caused.

### Docker re-verify -- RUN for real this task (closes the gap carried since t300/t400)

No existing compose target builds the bare production gateway image (`docker-compose.test.yml`
in `deploy/acquisition/` is the gateway's own `vitest run test/e2e` integration harness, a
different thing). Ran the direct build named in the task:
```
docker build -t acquisition-gateway-test -f services/acquisition-gateway/Dockerfile .
...
#22 exporting to image ... done
real  0m53.752s
```
Image size: `docker images acquisition-gateway-test` -> **1.16GB** (unchanged from the t100
Task-6 measurement -- still untrimmed, carried-forward non-blocking gap, not a regression).
Smoke test: `docker run --rm acquisition-gateway-test node dist/main.js --help` (WORKDIR is
already `/repo/services/acquisition-gateway` per the Dockerfile's final stage) ->
`acquisition-gateway: reads its configuration from environment variables. See
services/acquisition-gateway/src/config.ts.`, exit 0.

## Gate 4: CLOSED -- all 6 tasks done, both acceptance parts verified real

1. Cypress e2e journey passing at mobile AND desktop viewport widths: verified above, both
   green.
2. `corepack pnpm lint` / `typecheck` / `find-hardcoded-strings` all clean individually:
   verified above.

## Exact next task

Gate 4 is done. Next in the tracker sequence: t600 (Android vertical slice) and t1000
(rollout prep), both already unblocked.

## t600 continuation (wi1496-worker-9, 2026-08-24): Tasks 5-6 done, Gradle assembleDebug verified

Picked up after wi1496-worker-8 completed Tasks 1-4 (commits `12f1b370`..`97d6aed3`, see below).
Delivered the remaining plan scope:

**Task 5 -- Discover + acquisition queue (mobile).** New files: `mobile/src/api/acquisitionClient.ts`
(bearer-token wrapper around `@abs/acquisition-client`'s `createAcquisitionClient`, with the same
one-retry-on-401 pattern as `absClient.ts` but refreshing through `SessionStore.refresh()` instead
of the web app's cookie-based `/internal-api/refresh`), `mobile/src/contexts/AcquisitionContext.tsx`,
`mobile/src/routes/{DiscoverPage,AcquisitionQueuePage}.tsx`,
`mobile/src/components/{ReleaseCard,AcquisitionRow,ConfirmDialog}.tsx`. Modified
`AuthProvider.tsx` (exposes `acquisitionClient`, built lazily once authenticated),
`App.tsx` (routes + `AcquisitionProvider`), `LibraryPage.tsx` (Discover/Queue nav links),
`styles.css`. Both `Discover`/`AcquisitionQueuePage` accept an injectable API prop pattern
mirroring the web app's `DiscoverApi`/`AcquisitionQueueApi` seams. Per-release/per-acquisition
in-flight state is keyed by opaque `releaseId`/`acquisition.id`, never normalized title
(FND-00437), matching t500's rule.

**Deliberate deviation from the web app: poll-only, no SSE.** The web app's live queue updates
work because a same-origin `EventSource` automatically resends the ABS session cookie; ShelfDroid
carries bearer tokens only, and the stock `EventSource` API cannot attach a custom `Authorization`
header, so an unauthenticated connection to `/acquisition-api/v1/events` (which only accepts
`authorization`/`cookie` -- `services/acquisition-gateway/src/auth/absAuth.ts`) would just 401
forever. `AcquisitionContext.tsx` polls every 10s for actively-viewed libraries unconditionally --
exactly the web app's own SSE-disconnected fallback, made permanent. Documented inline and in
`mobile/README.md`.

New tests: `mobile/src/api/acquisitionClient.test.ts` (bearer token attached, 401-refresh-retry,
constructor guard, error-code mapping), `mobile/src/routes/DiscoverPage.test.tsx`,
`mobile/src/routes/AcquisitionQueuePage.test.tsx` (search/confirm/idempotency-key, disabled
non-requestable releases, retry, cancel-with-confirm, Open Book link keyed by `absItemId`).
Full mobile suite: 8 files / 26 tests passing (`corepack pnpm --filter @abs/mobile test`).
`corepack pnpm --filter @abs/mobile typecheck` clean. Root-scoped
`corepack pnpm exec eslint mobile/src` clean.

**Task 6.** `.github/workflows/android.yml` (separate CI job from `ci.yml`'s existing
`test:workspace`/`typecheck:workspace` -- installs JDK 21 via `actions/setup-java`, builds +
syncs the mobile bundle, runs `testDebugUnitTest assembleDebug`, uploads the APK artifact).
`mobile/README.md` (setup, JAVA_HOME toolchain gotcha, architecture notes, known Vite/Android
gotchas). `mobile/e2e/vertical-slice.spec.ts` + `mobile/playwright.config.ts` +
`mobile/e2e/support/fakeAbsServer.mjs` (zero-dependency fake ABS + acquisition-gateway backend,
same spirit as `cypress/e2e/support/fakeAbsServer.mjs` but far simpler since ShelfDroid is a pure
bearer-token client -- no JWT-shaping, no server-init/status probing needed). Added
`@abs/mobile`'s `e2e` script + `@playwright/test` devDependency; installed Chromium locally
(`corepack pnpm --filter @abs/mobile exec playwright install chromium`, ~192MB, succeeded --
network egress is available on this machine). Also fixed `mobile/vitest.config.ts` (excluded
`e2e/**` -- vitest's default include glob was picking up the Playwright `*.spec.ts` and failing
immediately with the wrong test runner globals) and root `eslint.config.js` (ignored
`mobile/android/app/src/main/assets/public/` -- Capacitor's `cap sync android` copies the built
minified web bundle there on every local build; it's gitignored and never committed, but a bare
`eslint .` still walked it and choked on a 260KB minified file, pre-existing noise unrelated to
this task's changes, not caused by it).

**Required Gradle build -- run for real, closes the plan's "debug APK assembles" acceptance
criterion** (was NOT verified by any prior worker or the orchestrator):
```
corepack pnpm --filter @abs/mobile build && corepack pnpm --filter @abs/mobile exec cap sync android
JAVA_HOME=C:\Users\scott\.gradle\jdks\jetbrains_s_r_o_-21-amd64-windows.2 \
  ./mobile/android/gradlew.bat -p mobile/android testDebugUnitTest assembleDebug
```
`BUILD SUCCESSFUL in 19s` (129 actionable tasks, 76 executed / 53 up-to-date;
`testDebugUnitTest` was `UP-TO-DATE` -- no Kotlin test sources changed this task, expected).
Produced `mobile/android/app/build/outputs/apk/debug/app-debug.apk` (5,024,685 bytes),
timestamped this run.

**e2e Playwright spec -- infra complete, NOT yet green; flagged as a GAP, not silently
carried.** The fake-server/config/spec trio is written, Chromium installs and launches, the
Vite dev server + fake server both start correctly under `playwright.config.ts`'s `webServer`
(fixed two real issues along the way: `pnpm exec vite` failing because bare `pnpm` isn't on
PATH -- call `vite` directly, since `playwright test` already runs inside a package-manager
script context with `node_modules/.bin` on PATH; and Vite's default `--host localhost`
resolving to an IPv6-only bind that `127.0.0.1` `baseURL` couldn't reach -- pinned
`--host 127.0.0.1` explicitly). Login itself still fails in the running spec (`LoginPage`
renders "Could not sign in. Check your server address and credentials." after clicking
Sign in) with **zero network requests observed to the fake server** (confirmed via temporary
`page.on('request'/'response'/'requestfailed'/'pageerror')` listeners -- no request to
`127.0.0.1:4545` at all, not even a failed/blocked one, and no `pageerror`), meaning
`SessionStore.login()` throws synchronously before ever calling `fetch`. Added CORS headers
(`access-control-allow-*` + `OPTIONS` preflight handling) to `fakeAbsServer.mjs` since the
mobile app calls it cross-origin from Vite's dev port -- confirmed via manual `curl` (including
a simulated preflight) that the server itself answers correctly outside the browser, so the
bug is client-side, not server-side. Root cause not yet isolated. Next debugging step: add a
`try/catch` around `normalizeServerUrl`/the `fetch` call in `session.login()` with a
`console.error` of the caught error (or step through with `page.pause()` /
`PWDEBUG=1 corepack pnpm --filter @abs/mobile e2e`) to see what actually throws before `fetch`
is reached.

Per-task status update (commits on `feature/mobile-acquisition-stack`, all local, none pushed):
- Task 5 (Discover + acquisition queue) -- DONE, verified (tests/typecheck/lint all green).
- Task 6 (CI, README, e2e infra, required Gradle assembleDebug) -- DONE except the e2e spec is
  not yet passing end-to-end (see above); everything else in Task 6 is complete and verified.

## t600: Android vertical slice (Plan 5) -- IN PROGRESS, Tasks 1-4/6 done, Task 5-6 not started

New `mobile/` pnpm workspace package (`@abs/mobile`; `pnpm-workspace.yaml` already listed
`mobile` before this session started). Vite 5 + React 19 + React Router 7 + Capacitor 7,
Vitest for unit tests (repo convention). Android project generated via `cap add android`
and committed under `mobile/android/` (build outputs gitignored:
`mobile/android/**/build/`, `.gradle/`, `local.properties`, `*.apk`/`*.aab`, `.cxx/`).

**Deviation from the plan's task ordering**: the plan's Task 2 file map needs
`mobile/android/app/src/main/java/.../MainActivity.kt`/`SecureSessionPlugin.kt` to exist,
but the plan's own Task 6 Step 1 is what generates `mobile/android/` via `cap add android`.
Ran `cap add android` right after Task 1 (before Task 2) instead of waiting for Task 6, so
the native Kotlin plugin has somewhere to live. Task 6 remaining work is CI + physical-device
smoke test + README, not project generation (already done).

**JAVA_HOME resolution (record so it isn't re-discovered)**: Android Studio is NOT installed
on this machine (only standalone SDK components at `%LOCALAPPDATA%\Android\Sdk`
-- platform-tools/build-tools/platforms, no bundled `jbr`). Gradle had already
auto-provisioned a JetBrains Runtime (JBR) 21 toolchain at
`C:\Users\scott\.gradle\jdks\jetbrains_s_r_o_-21-amd64-windows.2` (functionally identical
lineage to Android Studio's bundled jbr) -- used that as `JAVA_HOME` for all Gradle
invocations. AGP 8.7.2 + Capacitor 7's `capacitor-android` module require JDK 21
specifically (JDK 17, also present at `C:\Users\scott\AppData\Local\Temurin17\jdk-17.0.20+8`,
fails with `invalid source release: 21` compiling `capacitor-android`). `sdk.dir` written to
`mobile/android/local.properties` (gitignored, machine-local) pointing at
`%LOCALAPPDATA%\Android\Sdk`. First Gradle run auto-installed missing SDK Build-Tools 34 and
Platform 35 (compileSdk/targetSdk 35 per the plan) into that same SDK dir, accepting the
license non-interactively via the Gradle plugin's own auto-download (no separate
`sdkmanager --licenses` step was needed).

**Trap: `unitTests.returnDefaultValues = true` breaks `JSObject`/`JSONObject` in Kotlin unit
tests.** With that `testOptions` flag (needed so unrelated Android-stub calls don't throw),
`com.getcapacitor.JSObject.put()`/`.getString()` silently returns null/no-ops instead of
working, because Android's unit-test `android.jar` ships JSON classes that either throw
`Stub!` or (with `returnDefaultValues`) return defaults -- NOT a real implementation. Fixed
by adding `testImplementation "org.json:json:20240303"` (a real org.json jar) to
`mobile/android/app/build.gradle`; this shadows the broken stub on the unit-test classpath.
Cost ~3 debug iterations before isolating (confirmed via three throwaway inline tests
proving `FakeSecureStore` and `Mockito` both worked fine and only raw
`JSObject().put().getString()` was broken) -- if this resurfaces, check this dependency
first before suspecting Mockito or Kotlin property semantics.

Per-task status (commits on `feature/mobile-acquisition-stack`, all local, none pushed):
- Task 1 (scaffold) -- DONE, commit `12f1b370`. `pnpm --filter @abs/mobile test`/`build` both
  pass; `mobile/dist/index.html` exists with hashed local assets. Also fixed the same
  root-postcss-walk-up issue `packages/acquisition-client` hit (`css: { postcss: { plugins:
  [] } }` in both `vite.config.ts` and `vitest.config.ts`), and pinned `vite: ^5.4.11`
  (not `^6`) because `vitest@2.1.x`'s `vitest/config` re-export requires vite 5's `Plugin`
  type -- vite 6 + vitest 2 mismatched types broke `tsc -b` (`vite build` itself worked, only
  the `vitest.config.ts` type-check failed) until pinned back to vite 5.
- Task 2 (auth + secure storage) -- DONE, commit `cca0d7d7`. `SessionStore`/`createAbsClient` are DI factories (not
  singletons) specifically so `session.test.ts` can inject a fake `SessionVault` + fetcher --
  5 vitest cases (login+401-retry+refresh round trip, refresh failure surfaces original 401,
  vault restore, logout clears vault, tokens never logged). Native side:
  `SecureSessionPlugin.kt` (AndroidX Security `EncryptedSharedPreferences`, one JSON session
  blob) with a `SecureStore` interface seam so `SecureSessionPluginTest.kt` (4 cases) never
  touches the real Android Keystore. Added Kotlin support to the Capacitor-generated Gradle
  project (it ships Java-only by default): `kotlin-android` plugin, `kotlin_version =
  '2.0.21'`, `androidx.security:security-crypto:1.1.0-alpha06`. `minSdkVersion` bumped
  23->26 per the packet; debug builds get `applicationIdSuffix ".debug"`; manifest adds
  `POST_NOTIFICATIONS`, sets `usesCleartextTraffic="false"` with a debug-only manifest
  override (`android:usesCleartextTraffic="true"`) for local/LAN http servers during
  development.
- Task 3 (browse libraries/details) -- DONE, commit `a7b0a4af`. `LibrariesPage` ->
  `LibraryPage` -> `BookDetailsPage` navigation chain, `types/abs.ts` canonical ABS shapes
  (`AbsLibrary`/`AbsLibraryItem`/etc, imported by `absClient.ts` rather than duplicated).
  3 RTL tests in `LibraryPage.test.tsx` (book-only library filter, item click -> details
  navigation + `getLibraryItem` call, empty-library state) using an exported `AuthContext`
  (not just the `useAuth()` hook) so tests can inject a fake `AbsClient` without a real
  `AuthProvider`/Capacitor plugin round trip.
- Task 4 (stream + sync) -- DONE, commit `f66a60c9`. `HtmlAudioPlayer` takes an injectable
  `createAudio()` (defaults to `new Audio()`) so `htmlAudioPlayer.test.ts` /
  `progressSync.test.ts` (6 cases total) run against in-memory `AudioLike` fakes under
  `vi.useFakeTimers()` instead of jsdom's unimplemented `HTMLMediaElement.play()`. 15s sync
  interval, pause triggers an immediate sync + timer stop, seek does NOT sync, item
  replacement closes the previous session first. `PlayerProvider` uses `@capacitor/app`'s
  `appStateChange` listener to `close()` (not just pause) on app background per the spec.
  `PlayerPage` wired at `/library/:libraryId/item/:itemId/play`.
- Task 5 (Discover + acquisition queue) -- NOT STARTED. Reference material already read this
  session (don't re-read, just port): `src/contexts/AcquisitionContext.tsx` (SSE +10s-poll-
  fallback pattern, `ensureQueueLoaded`/`refreshQueue`/`applyAcquisition`),
  `src/components/acquisition/ReleaseCard.tsx` and `AcquisitionRow.tsx` (already read in
  full this session -- port the JSX/logic, drop `next-intl`/`Btn`/Tailwind, use plain
  className CSS matching `mobile/src/styles.css`'s existing dark-theme variables). Web pages
  NOT yet read this session: `src/app/(main)/library/[library]/discover/DiscoverClient.tsx`
  and `.../acquisition-queue/AcquisitionQueueClient.tsx` -- read those next for the exact
  confirm-dialog + UUID-idempotency-key + retry/cancel wiring before writing
  `mobile/src/routes/DiscoverPage.tsx`/`AcquisitionQueuePage.tsx`. Mobile-specific: no cookie
  session, so `acquisitionClient.ts` must build `createAcquisitionClient({ baseUrl:
  \`${session.serverUrl}/acquisition-api/v1\`, getAccessToken: async () =>
  session.accessToken })` from `@abs/acquisition-client` (already a `mobile/package.json`
  dependency) -- bearer auth, not cookies. Key any per-release UI state by opaque
  `releaseId`/`acquisition.id`, never normalized title (FND-00437 was exactly this bug in
  the prior native app attempt). Add both routes to `App.tsx` and a bottom nav (styles
  already scaffolded in `styles.css`'s `.app-bottom-nav`, just unused so far).
- Task 6 (Android/CI/device smoke) -- PARTIALLY DONE ahead of schedule: `mobile/android/`
  already generated and committed (see deviation note above), `compileSdk`/`targetSdk` 35
  and `minSdk` 26 already set, manifest permissions/cleartext already set. Remaining:
  `.github/workflows/android.yml` CI file, `mobile/e2e/vertical-slice.spec.ts` (plan says
  Playwright in the tech stack line but gives no concrete spec -- decide Playwright vs a
  simpler smoke script when picked back up), `mobile/README.md`, and the actual
  `assembleDebug` Gradle build + APK path evidence (only `testDebugUnitTest` has been run
  and verified green so far this session -- `assembleDebug` has NOT been run yet; expect it
  to need a live network fetch of additional AGP/Gradle dependencies and will take several
  minutes on first run).

Exact resume commands (from `mobile/android/`, JAVA_HOME set as above):
```
$env:JAVA_HOME = "C:\Users\scott\.gradle\jdks\jetbrains_s_r_o_-21-amd64-windows.2"
.\gradlew.bat -p . testDebugUnitTest assembleDebug
```
Then `corepack pnpm --filter @abs/mobile test`/`typecheck` and `corepack pnpm exec eslint
mobile/src` before each commit (all green as of Task 4's commit).

### Historical (t300 — already done)

Gate 2 (Librarr acquisition flow) is implemented and all tests pass (see Gate 2 section above), but **the working tree has NOT been committed yet** -- the worker that did this implementation hit its context-rotation threshold immediately after finishing verification. Next worker: review the uncommitted diff, then create the 5 per-task commits using the plan's own commit messages (task boundaries below), in order:
1. `feat: adapt Librarr audiobook API` -- `src/adapters/`, `test/fixtures/librarr/`, plus the `status.ts` real-health-check fix (carried from t200 HANDOFF, same task).
2. `feat: issue opaque acquisition search results` -- `src/domain/releaseIdentity.ts`, `src/services/searchService.ts`, `src/routes/search.ts`, contract's `SearchRelease`/`SearchResponse`/`SearchQuery` additions, client's `searchAudiobooks`.
3. `feat: submit exact Librarr releases idempotently` -- `src/domain/librarrTrackingKey.ts`, `src/services/acquisitionService.ts` (create only), `src/routes/acquisitions.ts` (POST/GET only), DB migration 2 (`tracking_key`/`stalled_since`), repo changes, PLUS the contract package's build-step conversion (`tsconfig.build.json`, `package.json` main/exports, Dockerfile build-order + runtime-stage copy, `.gitignore`/`eslint.config.js` `dist/` fixes) since that conversion's trigger condition is this task's first runtime `.parse()` call.
4. `feat: reconcile Librarr acquisition progress` -- `src/domain/statusNormalization.ts`, `src/services/reconciler.ts`, `app.ts` reconciler wiring, config's `STALL_TIMEOUT_SECONDS`/`RECONCILE_INTERVAL_MS`/`HISTORY_RETENTION_SECONDS`.
5. `feat: expose acquisition queue lifecycle` -- `src/events/`, `src/routes/events.ts`, `acquisitionService.retry()`/`cancel()`, `routes/acquisitions.ts` retry/cancel routes, contract's `AcquisitionEvent`, client's remaining methods.

These boundaries overlap in a few files (`app.ts`, `acquisitions.ts`, contract's `index.ts`, `acquisitionRepository.ts`) since they were written together for a working end state -- splitting the diff by hunk across commits 2-5 is acceptable if exact per-file boundaries aren't practical; do not spend excess effort forcing a clean split. Re-run `corepack pnpm --filter @abs/acquisition-gateway test` (62/62 expected), `corepack pnpm -r --if-present typecheck`, and `corepack pnpm lint` after committing to confirm nothing was lost in the split, then proceed to Plan 3 in the runbook sequence.
