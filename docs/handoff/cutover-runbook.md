# Acquisition Gateway Cutover Runbook (WI-1496 t1000)

Human-executed runbook for switching the droplet from WI-1486's direct-import stack to the
WI-1496 gateway/staging stack (DEC-2718: cutover is in scope, gated behind the disposable-stack
tests in step 3 below passing). No step in this document has been executed by any agent -- this
is preparation only, per this task's explicit out-of-scope list. `@user` scope (t1050) is what
actually runs it.

## 1. Current droplet state (as of this item's start)

The droplet runs the WI-1486 native ShelfDroid + direct-import stack, currently on hold
(DEC-2717 -- WI-1496 supersedes WI-1486's architecture; WI-1486 stays on hold as the working
stopgap, not retired). Concretely:

- Librarr's `AUDIOBOOK_DIR` points directly at `/usr/share/books`, ABS's real, live final
  library directory. Librarr writes finished audiobooks straight into it -- there is no
  staging tier and no gateway between download completion and ABS-visible library content.
- Librarr's `ABS_URL`/`ABS_TOKEN`/`ABS_LIBRARY_ID` are set, so on every startup its folder
  scanner walks `/usr/share/books`, auto-registers what it finds into its own DB, and
  triggers an ABS library scan (FND-00414) -- observed once already, at 98 pre-existing
  items, no writes, but it is not a passive read-only scan the way earlier phases assumed.
- The acquisition queue backend currently has 4 stuck entries in `Error` state at 0 B/s (two
  duplicate pairs), and a fresh Get on a previously-unrequested title does not reach the
  queue at all (FND-00442, still open as of this runbook's writing -- confirmed via `hf-wi
  finding get FND-00442`). Root cause not diagnosed from the droplet backend side.

## 2. Target state (per `docs/handoff/05-DEPLOYMENT-CONTRACT.md`)

- `AUDIOBOOK_DIR=/media/staging` in Librarr's env -- Librarr writes to a disposable staging
  tier, never to a final ABS library directory again.
- Librarr's `ABS_URL`, `ABS_TOKEN`, `ABS_LIBRARY_ID` all **unset** -- Librarr no longer talks
  to ABS at all; the gateway owns all ABS interaction (auth passthrough, scan trigger, item
  resolution).
- `acquisition-gateway` container mounts the same host staging directory (`/media/staging`,
  read/write) plus one volume per entry in `LIBRARY_MAPPINGS_JSON` (the gateway-visible final
  library roots, read/write for the gateway's atomic handoff; ABS sees the same host content
  through its own mount).
- Reverse proxy forwards `/acquisition-api/` to `acquisition-gateway:8080` **without
  stripping the prefix**, preserves `Host`/`X-Forwarded-Proto`/client-IP headers, and
  disables proxy buffering (long-lived response, no buffering) specifically for
  `/acquisition-api/v1/events` (SSE). Gateway port 8080 is never published to the host --
  reverse-proxy-only, per `02-SETTLED-DECISIONS.md`.

Illustrative nginx `location` block for the reverse-proxy requirement above (this is a
documentation snippet only -- the droplet's real, current nginx config is out of scope and
inaccessible from this repo; do not treat this as a deployable file):

```nginx
location /acquisition-api/ {
    proxy_pass http://acquisition-gateway:8080;   # note: NOT proxy_pass .../ (would strip prefix)
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}

location /acquisition-api/v1/events {
    proxy_pass http://acquisition-gateway:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_buffering off;       # required: SSE stream must not be buffered
    proxy_read_timeout 1h;     # long-lived connection
}
```

## 3. Pre-cutover requirements (blocking -- do not skip)

### 3a. Resolve FND-00442 before cutover

FND-00442 (`hf-wi finding get FND-00442`, high/bug, still open as of this writing) is a
**hard blocker**: the queue backend on the droplet is currently stuck (4 entries in `Error`,
new Gets never landing). Cutover must not proceed while the queue backend is provably broken
-- that would just move a live incident onto the new stack instead of fixing it. Diagnose and
clear this on the droplet's current (WI-1486) stack first, or confirm during step 3c's
disposable-library journey that the new gateway/Librarr pairing does not reproduce it (a
different failure mode from the same underlying Librarr/Decypharr/TorBox connectivity or auth
issue is plausible, since the gateway stack still talks to the same Librarr/Decypharr/TorBox
chain). Re-check `hf-wi finding get FND-00442` immediately before starting step 4 -- if it is
still open, stop and do not proceed past step 3.

### 3b. Account for FND-00414 (Librarr startup auto-scan)

Librarr's folder scanner auto-registers everything already under `AUDIOBOOK_DIR` into its own
DB and triggers one ABS scan on every startup where `ABS_URL` was previously configured,
regardless of intent (FND-00414). Cutover changes `AUDIOBOOK_DIR` from `/usr/share/books` to
`/media/staging` AND unsets `ABS_URL`/`ABS_TOKEN`/`ABS_LIBRARY_ID` in the same restart, so:

- Before restarting Librarr with the new env, stop Librarr, then clear Librarr's own local
  library DB rows that reference the old `/usr/share/books` path (Librarr's SQLite DB, not
  the gateway's -- do not touch `GATEWAY_DB_PATH`). Confirm Librarr's DB file location from
  its own container config before deleting rows; back it up first (Librarr's DB, separate
  from the gateway's backup in 3d) since this is a destructive edit to a database owned by a
  component this runbook does not otherwise touch.
- After the restart, Librarr's scanner will still walk the new (initially empty)
  `/media/staging` and register nothing -- this is expected and requires no action. The
  concerning case (98-item auto-scan against a populated library) does not recur once
  `AUDIOBOOK_DIR` points at an empty staging tier and `ABS_URL` is unset, since there is
  nothing to scan and nothing to notify.
- If for any reason `AUDIOBOOK_DIR` cannot be flipped to a genuinely empty staging directory
  at cutover time (e.g. a staging tier that already has content mid-migration), accept and
  explicitly log the one-time auto-scan rather than being surprised by it -- do not attempt
  to suppress Librarr's scanner behavior itself, it is not configurable per FND-00414's
  findings.

### 3c. Disposable-library import journey must pass first

Before any production `LIBRARY_MAPPINGS_JSON` entry is enabled, the acquisition flow must be
proven end-to-end against the real droplet's infrastructure using a **disposable ABS
library** (a throwaway library folder/ID on the same ABS instance, not the in-process fakes
`deploy/acquisition/docker-compose.test.yml` uses for Gate 3's CI journey -- that compose file
is CI-only reference, not part of this runbook). Concretely, "passes" means all of the
following, observed directly (not inferred):

1. Deploy the gateway + Librarr (target-state config from section 2) against the droplet,
   with `LIBRARY_MAPPINGS_JSON` containing **only** the disposable library's ID/root.
2. Submit a real acquisition (search + Get) through the mobile app or gateway API directly
   against a real, previously-unrequested title.
3. Watch it progress through the full lifecycle: queued -> downloading -> staged -> imported,
   observable via `/acquisition-api/v1/status` (or the SSE event stream) reaching a terminal
   `available` state with no manual intervention.
4. Confirm the book is visible in the disposable ABS library (via the ABS UI or API) with
   correct metadata, and that the staged tree under `/media/staging` has been cleaned up
   (per `IMPORT_CLEANUP_ENABLED=true`) with no leftover `.importing-*` directory.
5. Restart the `acquisition-gateway` container (`docker compose restart acquisition-gateway`)
   mid-lifecycle on a **second** acquisition (submit it, wait for it to reach `downloading` or
   `staged`, then restart) and confirm it resumes correctly rather than re-downloading or
   getting stuck -- the gateway's import coordinator persists `lastSuccessfulStage` per
   acquisition specifically so a restart resumes instead of restarting
   (`services/acquisition-gateway/src/services/importCoordinator.ts`); this restart check is
   what proves that contract in a real deployment, not just in the unit/e2e test suite.

Only after all 5 pass does step 4 proceed to add production library mappings.

### 3d. SQLite online backup of the gateway DB

Before any config change that could affect the gateway DB, take a proper backup using
SQLite's online backup mechanism -- never a raw copy of a live WAL-mode database file, which
can capture a torn/inconsistent snapshot:

```bash
# Preferred: SQLite's own online backup command (uses the online backup API internally,
# safe against a live WAL-mode writer).
sqlite3 /data/gateway.sqlite ".backup '/data/backups/gateway-$(date +%Y%m%dT%H%M%SZ).sqlite'"

# Verify the backup is a valid, complete database before trusting it:
sqlite3 /data/backups/gateway-<timestamp>.sqlite "PRAGMA integrity_check;"
```

If the `sqlite3` CLI is not available in the gateway container, run it from a container that
mounts the same `/data` volume read-only, or add it to the gateway image -- do not fall back
to `cp`/`tar` of the live `.sqlite`/`.sqlite-wal`/`.sqlite-shm` files.

## 4. Ordered cutover steps

Each step includes its own verification before moving to the next. Stop and follow section 5
(Rollback) if any verification fails.

1. **Confirm pre-cutover requirements (section 3) are all satisfied.**
   Verify: FND-00442 re-checked closed or confirmed non-reproducing (3a); Librarr DB rows
   cleared/backed up (3b); disposable-library journey's 5 checks all passed (3c); a verified
   gateway DB backup exists and passed `PRAGMA integrity_check` (3d).

2. **Prepare the real env files on the droplet**, outside this repo:
   `deploy/acquisition/compose.env.example` -> `compose.env` (mode default, non-secret) and
   `deploy/acquisition/acquisition-gateway.env.example` -> `acquisition-gateway.env` (mode
   `0600`, real secrets). Real `ABS_SERVICE_TOKEN`/`LIBRARR_API_KEY`/SSH target values live
   outside this repo at `G:\tools\ABS\wi-1496-secrets.env` on the operator's machine -- never
   copy that file's contents into this repo, a commit, or any file this runbook produces.
   Verify: `docker compose --env-file compose.env -f docker-compose.acquisition.yml config`
   exits 0 with the REAL values resolved (see the known-good reference invocation in section
   6 below, run there against placeholders only).

3. **Stop Librarr's existing container** (the WI-1486 direct-import instance).
   Verify: container stopped, no in-flight downloads lost (check Librarr's own queue state
   before stopping; let anything actively downloading finish or explicitly accept losing it).

4. **Re-point Librarr's env**: set `AUDIOBOOK_DIR=/media/staging`; unset `ABS_URL`,
   `ABS_TOKEN`, `ABS_LIBRARY_ID`. Mount `/media/staging` into Librarr (same host directory the
   gateway will mount).
   Verify: env file diff reviewed by a human before restart; no `ABS_*` variable present.

5. **Start Librarr with the new env.**
   Verify: Librarr starts cleanly; per 3b, its startup scan against the (now-cleared/empty)
   staging tree registers nothing unexpected; no ABS scan triggered.

6. **Deploy `acquisition-gateway`** using `docker-compose.acquisition.yml` with the real
   `compose.env`/`acquisition-gateway.env`, `LIBRARY_MAPPINGS_JSON` still scoped to the
   disposable library only (do not add production mappings yet).
   Verify: `GET /healthz` returns `{ok:true}`; authenticated `GET
   /acquisition-api/v1/status` reports `ready: true` (config valid, migrations applied, ABS
   and Librarr both reachable, at least one enabled mapped library).

7. **Reverse proxy**: add/enable the `/acquisition-api/` route (section 2's requirements:
   no prefix stripping, header passthrough, SSE buffering off for
   `/acquisition-api/v1/events`, gateway port never published to the host).
   Verify: from outside the droplet, `curl https://<host>/acquisition-api/v1/status` (with
   valid auth) succeeds through the proxy exactly as it did hitting the container directly in
   step 6; an SSE client connected to `/acquisition-api/v1/events` receives events without a
   proxy-imposed buffering delay.

8. **Re-run the disposable-library journey (3c) one more time end-to-end through the full
   deployed path**, including the proxy this time (step 6 verified the container directly;
   this step verifies the whole path a real client uses).
   Verify: same 5 checks as 3c, now through the public route.

9. **Add production library mappings** to `LIBRARY_MAPPINGS_JSON` one at a time (not all at
   once), restarting the gateway between each addition.
   Verify after each addition: `/acquisition-api/v1/status` still reports `ready: true`;
   config parsing did not reject the new mapping (duplicate root, overlapping staging/library
   root, and similar are fail-closed per `services/acquisition-gateway/src/config.ts`).

10. **Final smoke test**: submit one real acquisition against a real production library
    mapping and confirm it completes end-to-end (same 5 checks as 3c/8, against production
    data this time). Only after this passes is cutover considered complete.

## 5. Rollback

Exactly what `05-DEPLOYMENT-CONTRACT.md`'s Backup and rollback section specifies -- do not
improvise beyond it:

- **Disable the public proxy route** for `/acquisition-api/` (revert the reverse-proxy change
  from step 7) and **stop only the `acquisition-gateway` container** (`docker compose stop
  acquisition-gateway` -- not `down -v`, which would also remove volumes).
- **Never delete** the gateway's SQLite database, the staging directory contents, or any
  final/library media as part of rollback, even if something looks wrong -- rollback removes
  the gateway's public surface, it does not clean up data.
- **Never automatically reverse-move** a book that has already reached an `available` state
  in a production library back out of it. If a rollback is needed after some books have
  already imported successfully, those books stay where they are.
- **Clean orphaned `.importing-*` directories only through the gateway's own verified
  recovery/cleanup path** -- there is currently no standalone CLI command for this in the
  repo; recovery is automatic, keyed on each acquisition's persisted `lastSuccessfulStage`
  (`services/acquisition-gateway/src/services/importCoordinator.ts`), and is triggered by
  restarting the gateway or by the `POST /acquisitions/:acquisitionId/retry` route, never by
  a manual `rm -rf` of anything under a library or staging root.
- If rollback is triggered specifically because of a bad Librarr re-point (step 4), reverse
  steps 4-5 (restore Librarr's original `AUDIOBOOK_DIR=/usr/share/books` and
  `ABS_URL`/`ABS_TOKEN`/`ABS_LIBRARY_ID`) as its own explicit action, separate from the
  gateway-stop above -- reverting Librarr's env does not itself require deleting anything
  either.
- To restore from a backup taken in 3d (only if the gateway DB itself is corrupted, not for a
  routine rollback): stop `acquisition-gateway`, replace `/data/gateway.sqlite` (and remove
  any stale `-wal`/`-shm` files) with the verified backup, then restart.

## 6. Known-good validation command (reference)

Run from `deploy/acquisition/` after copying the `.example` files to real (gitignored,
never-committed) copies and filling in real values:

```
$ docker compose --env-file compose.env -f docker-compose.acquisition.yml config
```

Verified working this task (2026-08-24, WI-1496 t1000) against the `.example` placeholder
values themselves (copied to temporary local `compose.env`/`acquisition-gateway.env`, deleted
immediately after validation, never committed) -- exit 0, output below, only placeholder
values resolved, nothing that looks like a real hostname/token/path:

```yaml
name: acquisition
services:
  acquisition-gateway:
    environment:
      ABS_INTERNAL_URL: http://audiobookshelf:13378
      ABS_SERVICE_TOKEN: replace-with-abs-service-token
      FINAL_TREE_DIR_MODE: "0755"
      FINAL_TREE_FILE_MODE: "0644"
      FINAL_TREE_MODE: preserve
      GATEWAY_DB_PATH: /data/gateway.sqlite
      HISTORY_RETENTION_SECONDS: "604800"
      IMPORT_CLEANUP_ENABLED: "true"
      LIBRARR_API_KEY: replace-with-librarr-api-key
      LIBRARR_INTERNAL_URL: http://librarr:5050
      LIBRARY_MAPPINGS_JSON: '{"replace-with-abs-library-id":"/media/audiobooks"}'
      PORT: "8080"
      RECONCILE_INTERVAL_MS: "15000"
      SEARCH_TTL_SECONDS: "900"
      STAGING_ROOT: /media/staging
      STAGING_STABILITY_SECONDS: "30"
      STALL_TIMEOUT_SECONDS: "1800"
    image: ghcr.io/REPLACE-WITH-OWNER/audiobookshelf-acquisition-gateway:latest
    networks:
      default: null
    volumes:
      - type: volume
        source: gateway-data
        target: /data
        volume: {}
      - type: volume
        source: audiobook-media
        target: /media
        volume: {}
networks:
  default:
    name: acquisition_default
volumes:
  audiobook-media:
    name: audiobook-media
    external: true
  gateway-data:
    name: acquisition_gateway-data
```

Note: this run used `acquisition-gateway.env.example`'s variable names, which match the real
`services/acquisition-gateway/src/config.ts` parser -- these differ from
`05-DEPLOYMENT-CONTRACT.md`'s documented table in several places (see
`docs/implementation-status.md`'s t1000 section for the full drift list). Use the `.example`
files in this repo, not the contract doc's table, as the source of truth for variable names.
