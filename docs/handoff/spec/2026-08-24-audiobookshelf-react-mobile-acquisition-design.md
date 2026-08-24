# Audiobookshelf React Mobile and Acquisition Gateway Design

Date: 2026-08-24

## Summary

Build a dedicated acquisition gateway beside Audiobookshelf, Librarr, and Decypharr. The gateway exposes a stable, authenticated API to the React web client and a new React/Capacitor Android application. It owns cross-system acquisition tracking and the final filesystem handoff into Audiobookshelf, while Audiobookshelf remains unmodified.

Librarr remains authoritative for search and download execution. Decypharr uses TorBox as the default debrid provider; other supported debrid providers remain optional fallbacks. The clients never receive provider credentials, raw provider URLs, service tokens, or filesystem paths.

The work is divided into independently deliverable tracks:

1. Acquisition gateway and shared contract
2. React web acquisition interface
3. React/Capacitor Android vertical slice
4. Native Android parity and production rollout

## Goals

- Keep the Audiobookshelf server on its upstream implementation with no custom controllers, models, migrations, settings, or socket events.
- Let users search for audiobook releases, select an exact release, request acquisition, monitor progress, and open the imported Audiobookshelf item.
- Keep Librarr, Audiobookshelf, Decypharr, and debrid credentials on the server.
- Persist enough correlation state to recover after any container restarts.
- Ensure incomplete files never appear in an Audiobookshelf library.
- Deliver a real Android application with locally packaged React assets and native playback/download services, rather than a Trusted Web Activity or a production remote-URL Capacitor configuration.
- Preserve a narrow customization surface in the actively developed React client.

## Non-goals

- Adding acquisition code to the Audiobookshelf server.
- Reimplementing Librarr search engines, provider scoring, or download execution in the gateway.
- Exposing TorBox, Decypharr, Librarr, or Audiobookshelf service credentials to either client.
- Requiring complete Android Auto, widget, and Chromecast parity before the first usable Android APK.
- Making the acquisition client responsible for filesystem management or import matching.
- Supporting iOS in the first release.

## System Architecture

```text
React web client --------------------+
                                      |
React/Capacitor Android app ----------+--> Acquisition Gateway
                                               |
                                               +--> Librarr
                                               |      |
                                               |      +--> Decypharr --> TorBox
                                               |
                                               +--> Staging and ABS library volumes
                                               |
                                               +--> Unmodified Audiobookshelf API
```

Deploy these services beside one another:

```text
audiobookshelf
audiobookshelf-react
acquisition-gateway
librarr
decypharr
```

The public reverse proxy exposes the acquisition gateway under the same origin and within the same cookie path as the React-hosted Audiobookshelf client:

```text
https://books.example.com/acquisition-api/* -> acquisition-gateway:8080
https://books.example.com/*                 -> audiobookshelf-react/ABS
```

If Audiobookshelf is mounted under a subfolder, the gateway route must remain within that deployment's session-cookie path.

## Ownership Boundaries

### Acquisition gateway

The gateway is a standalone TypeScript service using Fastify, SQLite, and shared runtime validation schemas. It owns:

- Audiobookshelf session validation and authorization
- A stable versioned client API
- Librarr API adaptation and response normalization
- Exact-release identity and search-session expiry
- User-to-acquisition ownership
- Cross-system identifiers and normalized lifecycle state
- Restart reconciliation
- File staging validation and final library handoff
- Audiobookshelf scan requests and imported-item resolution
- Retry, cancellation, error reporting, and cleanup policy
- SSE notifications, with polling-compatible resource endpoints

The gateway does not copy Librarr's complete job model. It stores only the state needed to correlate a user request, a Librarr job, filesystem handoff, and the final Audiobookshelf item.

### Librarr

Librarr remains authoritative for:

- Search sources and aggregation
- Release metadata and scoring
- Download submission
- Download-provider routing
- Download execution and provider progress
- Provider-specific retries and errors

Librarr writes completed audiobook output to a gateway-visible staging volume. It does not perform the final Audiobookshelf import for this integration.

### Decypharr and TorBox

Decypharr presents the downloader-compatible integration used by Librarr. TorBox is the default debrid provider. Provider selection remains infrastructure configuration and is not represented in the client API.

### Audiobookshelf

Audiobookshelf remains authoritative for:

- Users, sessions, and library permissions
- Library configuration
- Imported library items and metadata
- Playback sessions and progress
- Streaming and item download APIs

The gateway interacts with Audiobookshelf only through supported API calls and ordinary files placed in configured library folders.

### Clients

The clients own presentation and user interaction only. They may search, submit an opaque release identity, display normalized state, retry or cancel eligible work, and navigate to a confirmed Audiobookshelf item.

## Authentication and Authorization

### Web client

The reverse proxy makes the gateway same-origin with the React client. The browser automatically includes the Audiobookshelf HTTP-only session cookie. The gateway extracts the access token and validates it by calling Audiobookshelf's authenticated current-user endpoint. Validation results may be cached briefly by token fingerprint, but a denied or expired session always fails closed.

An acquisition authentication failure never clears or refreshes Audiobookshelf browser state. The React client reports the gateway error independently.

### Android client

The Android application authenticates normally with Audiobookshelf and stores its refreshable session through the native secure-storage bridge. It sends its current Audiobookshelf access token as a bearer credential to the gateway. The gateway validates that token against Audiobookshelf before serving the request.

### Authorization

For the initial single-user deployment, any authenticated active user with access to the selected book library may search and acquire. The gateway still persists the Audiobookshelf user ID and filters queue/history responses to that user. The contract leaves room for an explicit `canAcquire` policy without requiring an Audiobookshelf permission change.

The gateway uses its own server-side Audiobookshelf API token only for scans and administrative item resolution. That token is never accepted from or returned to a client.

## Public API Contract

All gateway endpoints live under `/acquisition-api/v1`.

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/status` | Gateway health, feature availability, and enabled libraries |
| `GET` | `/libraries/:libraryId/search?q=` | Search normalized audiobook releases |
| `POST` | `/libraries/:libraryId/acquisitions` | Acquire one exact release |
| `GET` | `/libraries/:libraryId/acquisitions` | Current queue and recent history for the user |
| `GET` | `/acquisitions/:acquisitionId` | Detailed normalized state |
| `POST` | `/acquisitions/:acquisitionId/retry` | Retry an eligible failed stage |
| `POST` | `/acquisitions/:acquisitionId/cancel` | Cancel active downstream work where possible |
| `GET` | `/events` | User-scoped server-sent events |

The shared `acquisition-contract` package defines request/response types, runtime validation schemas, lifecycle states, error codes, and API version compatibility.

### Search identity

Search returns a `searchSessionId` and an opaque `releaseId` for each result. The gateway retains the normalized search snapshot for a bounded period. Acquisition requests submit only those identifiers plus an idempotency key; clients do not submit raw provider URLs.

The gateway rejects expired sessions, unknown releases, changed library access, and duplicate idempotency keys with stable machine-readable errors.

### Search result fields

A normalized result contains only client-safe fields:

- `releaseId`
- `title`
- `author`
- `narrators`
- `format`
- `sizeBytes`
- `durationSeconds` when available
- `sourceLabel`
- `qualityLabel`
- `seeders` when meaningful
- `coverUrl` when available
- `alreadyOwned`
- `existingAbsItemId` when confidently known

## Persistent Data Model

The SQLite acquisition record contains:

```text
id
abs_user_id
abs_library_id
idempotency_key
search_session_id
release_id
librarr_job_id
title
author
narrators_json
format
size_bytes
source_label
state
progress_percent
staging_path
final_path
abs_item_id
error_code
error_message
error_retryable
last_successful_stage
created_at
updated_at
completed_at
```

Search snapshots have a short expiry and are removable after their associated acquisition record has captured the required display metadata. Terminal acquisition history is retained long enough to support queue history and troubleshooting, with retention configurable by environment variable.

## Acquisition Lifecycle

Normal states are:

```text
queued
submitted
downloading
processing
staged
importing
scanning
available
```

Terminal or intervention states are:

```text
failed
cancelled
needs_attention
```

State transitions are monotonic except for an explicit retry, which resumes from the last successful stage. Each transition is persisted before an external side effect when practical, and the side effect is idempotent.

### Request flow

1. The client searches a selected Audiobookshelf book library.
2. The gateway validates the user and library access.
3. The gateway searches Librarr and creates an expiring normalized search snapshot.
4. The user selects one exact release.
5. The client submits the search and release identifiers with an idempotency key.
6. The gateway persists `queued`, then submits the release to Librarr.
7. The gateway stores the Librarr job ID and reconciles progress into normalized states.
8. Librarr writes completed output into the staging volume.
9. The gateway validates the staged result and chooses the final author/title destination.
10. The gateway performs a safe final handoff into the selected Audiobookshelf library.
11. The gateway requests a normal Audiobookshelf scan.
12. The gateway resolves the newly imported item using metadata, path, library, and scan-time evidence.
13. The gateway persists the confirmed `abs_item_id` and marks the request `available`.
14. The client offers an Open Book action using the confirmed item ID.

## Filesystem Handoff

The staging and final library directories should be separate directories on the same mounted filesystem. This allows the final handoff to use an atomic rename.

Before handoff, the gateway validates:

- The output is within the configured staging root.
- At least one supported audiobook file is present.
- Files are no longer changing.
- Total size is consistent with the completed Librarr job when that data exists.
- The destination library belongs to the requested Audiobookshelf library mapping.
- The destination path is normalized and cannot escape the configured root.

When the staging and final directories cannot share a filesystem, the gateway copies to a hidden temporary destination, verifies byte counts and optional checksums, then renames the temporary directory into place. It removes the source only after the final rename succeeds.

Partial content is never placed under the visible final title directory. Cancellation never automatically deletes an already imported title.

## Import Resolution

The gateway marks an acquisition `available` only after confirming an Audiobookshelf item ID.

Resolution uses, in order:

1. Exact final path or relative path when exposed by the ABS response
2. Library ID plus normalized title/author and scan-time window
3. Strong external identifiers captured from the release or processed metadata

Title-only matching is insufficient. Multiple plausible matches produce `needs_attention` rather than choosing arbitrarily. A failed scan or unresolved import retries only the scan/resolution stage; it never resubmits the download.

## React Web Client

Add these routes to the existing Next.js application:

- `/library/[library]/discover`
- `/library/[library]/acquisition-queue`
- `/settings/acquisition`

The book-library navigation shows Discover only when the gateway reports that acquisition is enabled for that library. Queue access appears from Discover. The settings page reports gateway version, reachability, Librarr reachability, staging readiness, and configured library mappings without returning secrets.

Search cards display exact release attributes. Acquire requires confirmation and disables duplicate submission while the request is pending. Queue rows display normalized status, clamped progress, retryable errors, and Open Book when `absItemId` is present.

The client consumes SSE while the page is active and falls back to bounded polling. It does not add custom events to Audiobookshelf's socket server.

## React/Capacitor Android Application

The Android application is a locally packaged client-rendered React application. It does not load the hosted Next.js application through Capacitor's remote server URL.

Recommended repository layout:

```text
audiobookshelf-client-react/
|-- src/                         Existing Next.js web client
|-- packages/
|   |-- acquisition-contract/    Shared schemas and DTOs
|   `-- acquisition-client/      Typed gateway client
|-- services/
|   `-- acquisition-gateway/     Independently built Fastify service
`-- mobile/
    |-- src/                     Vite/React mobile application
    |-- capacitor.config.ts
    `-- android/                 Native project and plugins
```

Keeping the gateway source in this workspace allows all three applications to consume the same runtime schemas without modifying or rebuilding Audiobookshelf. The gateway still has its own container image, process, database, configuration, release lifecycle, and network boundary.

The mobile and web clients initially share contracts and API behavior, not complete page components. This avoids coupling mobile navigation and native lifecycles to Next.js server rendering, server actions, cookies, and routing.

### Android delivery milestones

#### Milestone 1: vertical slice

- Server connection and Audiobookshelf authentication
- Book-library browsing
- Book details
- Streaming playback
- Playback progress synchronization
- Discover and exact-release selection
- Acquisition queue and Open Book
- Signed debug APK

#### Milestone 2: native playback reliability

- Port the official app's native audio-player bridge
- Foreground playback service
- Media notification and lock-screen controls
- Headset and Bluetooth controls
- Sleep timer
- Secure connection storage
- Process-death recovery

#### Milestone 3: offline support

- Port the native downloader and download service
- Local SQLite catalog
- Filesystem and Storage Access Framework support
- Offline playback
- Interrupted-download recovery and cleanup
- Cellular-download policy

#### Milestone 4: extended parity

- Android Auto
- Home-screen player widget
- Chromecast integration
- Deep links and intents
- Remaining official-app settings and secondary features

The gateway and React web acquisition interface may ship before the Android application reaches extended parity. The gateway contract remains unchanged across these milestones.

## Error Handling and Recovery

- Every create request requires an idempotency key. Repeated taps and network retries return the existing acquisition instead of creating another job.
- Librarr failures affect acquisition only and never invalidate the Audiobookshelf client session.
- Progress is clamped to `0` through `100`; unknown progress is represented as indeterminate.
- On startup, the gateway reconciles every nonterminal record with Librarr and the filesystem before accepting mutation requests.
- Missing Librarr jobs do not automatically cause resubmission. The gateway inspects staging and final paths before deciding the correct recovery state.
- Failed scans resume at scanning. Failed matching resumes at resolution. Neither stage resubmits the download.
- Each failure exposes a stable error code, readable message, retryability flag, and last successful stage.
- SSE disconnection does not change state; clients resume with polling and reconnect using the last event ID.
- A cancellation stops downstream work where supported but preserves imported library content.

## Testing Strategy

### Gateway

- Unit tests for state transitions, path construction, matching, status normalization, idempotency, and retry policy
- Runtime contract tests for every endpoint
- Adapter tests against captured Librarr and Audiobookshelf responses
- Filesystem tests using temporary staging and library volumes
- Integration tests with fake Librarr and Audiobookshelf services
- Restart reconciliation, duplicate-submission, interrupted-copy, and ambiguous-match tests

### React web

- Component tests for search, confirmation, queue rows, progress, and errors
- Shared-schema compatibility tests
- Cypress journey covering search, acquire, queue, availability, and Open Book
- Narrow mobile viewport coverage

### Android

- Shared client-contract tests
- Native bridge tests
- Instrumented playback-service and offline-download tests
- Process-death, connectivity-loss, and interrupted-download tests
- Physical-device smoke test before a release APK

### Integrated deployment

- Docker Compose journey using isolated staging and disposable Audiobookshelf library volumes
- Simulated restarts of gateway, Librarr, and Audiobookshelf during different lifecycle stages
- Verification that production library paths are never used in automated tests

## Deployment and Configuration

The gateway is distributed as a dedicated container. Configuration uses environment variables and mounted volumes. Expected configuration includes:

- Public base path
- Internal Audiobookshelf URL and service token
- Internal Librarr URL and API key
- SQLite database path
- Staging root
- Per-library mapping from ABS library ID to final filesystem root
- Search-session expiry
- Terminal-history retention
- Reconciliation and polling intervals

Secrets are set through container environment or secret mounts and never returned through status endpoints.

The gateway SQLite database and configuration receive normal backups. Staging content is disposable. The final Audiobookshelf library remains authoritative.

## Rollout Sequence

1. Deploy the gateway with fake adapters and validate authentication.
2. Connect Librarr in search-only mode.
3. Enable downloads into an isolated staging directory.
4. Import into a disposable Audiobookshelf library.
5. Enable the React web acquisition routes.
6. Validate the full search-to-Open-Book journey.
7. Enable the production library mapping.
8. Begin Android vertical-slice device testing.
9. Add native playback, offline, and extended parity milestones incrementally.

## Acceptance Criteria

- Audiobookshelf server source and database schema remain unchanged.
- A logged-in authorized user can search and acquire an exact release without seeing provider credentials or URLs.
- Duplicate submissions with the same idempotency key create one Librarr job.
- Gateway restart during any nonterminal stage resumes or reports the correct state without duplicating downloads.
- No partial import becomes visible in Audiobookshelf.
- `available` always includes a confirmed Audiobookshelf item ID.
- Ambiguous imports become `needs_attention` instead of opening the wrong book.
- React web completes the search-to-Open-Book journey at mobile and desktop widths.
- The first Android vertical slice authenticates, browses, streams, synchronizes progress, acquires, monitors, and opens the resulting item.
- Native playback and offline milestones can be delivered without changing the acquisition gateway API.

## Implementation Planning Decomposition

This design should produce separate dependency-ordered implementation plans:

1. Gateway foundation, authentication, shared contract, and persistence
2. Librarr adapter and exact-release acquisition
3. Filesystem handoff, ABS scanning, and item resolution
4. React web acquisition interface
5. Android React vertical slice
6. Native playback reliability
7. Offline download support
8. Android extended parity and production release

Each plan must define its own testable acceptance checkpoint and may begin only after its dependencies have passed verification.
