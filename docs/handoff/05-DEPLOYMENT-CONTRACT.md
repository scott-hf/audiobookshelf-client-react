# Deployment Contract

This fixes configuration names and topology so implementation does not stall on deployment questions. The templates are target-state examples; Claude should make the generated repository files agree with them.

## Required gateway environment

| Variable | Required/default | Meaning |
|---|---|---|
| `PORT` | `8080` | Internal listen port |
| `PUBLIC_BASE_PATH` | `/acquisition-api/v1` | Registered public API prefix |
| `ABS_INTERNAL_URL` | required | Container-reachable ABS origin, no trailing slash |
| `ABS_SERVICE_TOKEN` | required secret | Admin/API token for scan and item queries |
| `LIBRARR_INTERNAL_URL` | required | Container-reachable Librarr origin |
| `LIBRARR_API_KEY` | required secret | Librarr API key |
| `GATEWAY_DB_PATH` | `/data/acquisition.sqlite` | SQLite file |
| `STAGING_ROOT` | `/media/staging` | Librarr output/gateway input |
| `LIBRARY_MAPPINGS_JSON` | required | JSON object of ABS library ID to mounted final root |
| `SEARCH_TTL_SECONDS` | `900` | Search snapshot TTL |
| `HISTORY_RETENTION_DAYS` | `30` | Terminal record retention |
| `AUTH_CACHE_SECONDS` | `30` | Successful ABS user validation cache |
| `RECONCILE_INTERVAL_SECONDS` | `5` | State reconciliation cadence |
| `STAGING_STABILITY_SECONDS` | `30` | Minimum unchanged staging interval |
| `ABS_RESOLUTION_TIMEOUT_SECONDS` | `300` | Maximum scan/item resolution window |
| `LOG_LEVEL` | `info` | Structured log level |

Configuration parsing fails closed on an invalid URL, relative/root path, missing secret, malformed mapping, duplicate root, or overlapping staging/library root.

## Required volume ownership

| Path in gateway | Mode | Owner |
|---|---|---|
| `/data` | read/write | Gateway SQLite |
| `/media/staging` | read/write | Librarr writes; gateway validates/removes |
| `/media/abs-books` (or one mount per mapping) | read/write | Gateway final handoff; ABS scans same host content |

ABS and gateway may see different container paths for the same host directory. `LIBRARY_MAPPINGS_JSON` uses the gateway-visible path. Item resolution must normalize/compare the ABS-reported path through an explicit configured path translation if container paths differ; never guess. If paths cannot be translated, fall back only to the strong evidence rules in Plan 3.

## Librarr deployment

Set:

```dotenv
AUDIOBOOK_DIR=/media/staging
ABS_URL=
ABS_TOKEN=
ABS_LIBRARY_ID=
```

Mount the same host staging directory into Librarr and the gateway. Librarr must not write directly into any ABS final library for this integration.

Use separate runtime files: copy `acquisition-gateway.env.example` to a secret, mode-`0600` gateway env file and copy `compose.env.example` to a non-secret Compose interpolation file. Validate with:

```bash
docker compose --env-file compose.env -f docker-compose.acquisition.yml config
```

## Reverse proxy

- Terminate HTTPS at the existing proxy.
- Forward `/acquisition-api/` to `acquisition-gateway:8080` without stripping the path.
- Forward the rest of the origin according to the existing ABS React deployment.
- Preserve `Host`, `X-Forwarded-Proto`, and client IP headers.
- Disable proxy buffering for `/acquisition-api/v1/events` and allow long-lived SSE responses.
- Do not expose internal `/healthz` through a more privileged information response; it contains only `{ok:true}` either way.

## Readiness behavior

- `/healthz`: process/liveness only, unauthenticated, no dependency/config details.
- Authenticated `/acquisition-api/v1/status`: `ready` is true only when configuration is valid, migrations are applied, ABS validation is reachable, Librarr is reachable, and at least one enabled mapped book library exists.
- A dependency outage returns a sanitized capability/status error; it never leaks internal URLs.

## Backup and rollback

- Back up `/data/acquisition.sqlite` with SQLite’s online backup API or a quiesced copy; never copy a live WAL database as one file.
- Rollback disables the public proxy route and stops only `acquisition-gateway`; it does not delete SQLite, staging, or final media.
- Never reverse-move an already available book automatically during rollback.
- Clean orphaned `.importing-*` directories only through the gateway’s verified recovery/cleanup command, not a broad shell delete.
