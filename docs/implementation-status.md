# Mobile Acquisition Implementation Status

- Started: 2026-08-24T10:19:02Z
- Baseline: master @ ff3274f3291735dd857adbff4dac5f09991790ce
- Branch: feature/mobile-acquisition-stack
- Current commit: 931f25f61aa250e3986366926201c04a9b54a52a

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

## Known blockers / external checks

- `corepack pnpm find-hardcoded-strings` reports "0 files" scanned — scope not investigated this task; confirm expected behavior before relying on it as a real gate in a later task.
- `pnpm check` (and `pnpm typecheck:workspace`/`pnpm test:workspace` at the root) will keep failing as a single command on this machine until either `pnpm` is added to PATH or the scripts are changed to invoke `pnpm run` sub-scripts explicitly; flagged for awareness, not fixed here (out of this task's scope). Always run the underlying `corepack pnpm ...` command directly instead.
- Acquisition gateway Docker image is ~1.16GB — see Task 6 deviation note above. Not a functional blocker for Gate 1, but should be revisited before any real deployment.
- `checkLibrarrReachable` in `services/acquisition-gateway/src/routes/status.ts` uses a placeholder liveness probe, not Librarr's real health route — needs confirming/wiring in the Librarr acquisition flow plan.
- `packages/acquisition-contract` has no build/dist output yet (its `package.json` `main`/`types` point straight at `src/index.ts`). This is fine today because the gateway only consumes it via `import type` (erased at compile time, no runtime dependency) — but the moment a later task needs runtime schema validation (e.g. `CreateAcquisitionBodySchema.parse(...)` in a route handler) inside the gateway's compiled `dist/`, the contract package will need a real build step, or the gateway's CJS build will fail trying to `require()` a `.ts` file. Flag for whichever task first does runtime validation with the contract package.

## Security review

- No `server.url`, production hostname, token, key, or keystore was added. Only markdown docs (handoff copy, README, this status file) were added; no source/config changed.

## Exact next task

Gate 1 (gateway foundation) is met. Proceed to Phase 1's next plan in sequence per `03-OVERNIGHT-RUNBOOK.md`: **Librarr acquisition flow** (`docs/handoff/plans/2026-08-24-librarr-acquisition-flow-implementation-plan.md`), using `work/librarr @ 1b86eb1` (not `G:\tools\ABS\librarr` or this package's `reference/librarr`, both stale) as the authoritative source per this item's base-instruction "Verified corrections". While there, also firm up `checkLibrarrReachable`'s real health endpoint (see Known blockers above). After that: **Import handoff** plan, completing the mandatory Phase 1 tracer bullet before any UI work (Gate 3).
