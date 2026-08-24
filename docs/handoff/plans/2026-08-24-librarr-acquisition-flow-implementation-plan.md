# Librarr Acquisition Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement exact-release search, idempotent submission, normalized queue state, retry/cancel operations, restart reconciliation, and user-scoped SSE on top of Librarr.

**Architecture:** The gateway stores raw Librarr search results only in expiring SQLite snapshots and returns opaque result IDs to clients. Submission rehydrates the exact snapshot entry, sends it to Librarr with the server-side API key, and correlates progress by returned job ID, NZB ID, or normalized info hash.

**Tech Stack:** TypeScript, Fastify, Zod, SQLite, Vitest, Librarr HTTP API

---

## File Map

| Path | Responsibility |
|---|---|
| `services/acquisition-gateway/src/adapters/librarrSchemas.ts` | Runtime schemas for Librarr payloads |
| `services/acquisition-gateway/src/adapters/librarrClient.ts` | Search, submit, queue, retry, cancel |
| `services/acquisition-gateway/src/domain/releaseIdentity.ts` | Opaque session/result IDs and hash normalization |
| `services/acquisition-gateway/src/domain/statusNormalization.ts` | Librarr-to-gateway state mapping |
| `services/acquisition-gateway/src/services/searchService.ts` | Search snapshots and ownership annotation |
| `services/acquisition-gateway/src/services/acquisitionService.ts` | Idempotent request creation and mutations |
| `services/acquisition-gateway/src/services/reconciler.ts` | Durable background state reconciliation |
| `services/acquisition-gateway/src/events/eventBus.ts` | User-scoped replayable events |
| `services/acquisition-gateway/src/routes/` | Public v1 search, queue, mutation, and SSE routes |

### Task 1: Lock the Librarr adapter to captured fixtures

**Files:**
- Create: `services/acquisition-gateway/src/adapters/librarrSchemas.ts`
- Create: `services/acquisition-gateway/src/adapters/librarrClient.ts`
- Create: `services/acquisition-gateway/test/fixtures/librarr/search-audiobooks.json`
- Create: `services/acquisition-gateway/test/fixtures/librarr/downloads.json`
- Test: `services/acquisition-gateway/src/adapters/librarrClient.test.ts`

- [ ] **Step 1: Add fixtures with stable torrent and NZB identities**

```json
{
  "results": [
    {"source":"prowlarr_audiobook","title":"Project Hail Mary","author":"Andy Weir","size":742000000,"seeders":21,"format":"m4b","media_type":"audiobook","info_hash":"0123456789abcdef0123456789abcdef01234567","magnet_url":"magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567"},
    {"source":"prowlarr_audiobook","title":"Project Hail Mary","author":"Andy Weir","size":1200000000,"format":"mp3","media_type":"audiobook","download_protocol":"nzb","guid":"nzb-release-2","download_url":"https://indexer.test/get/2.nzb"}
  ],
  "search_time_ms": 42,
  "sources": []
}
```

- [ ] **Step 2: Write failing adapter tests**

```ts
it('authenticates search and preserves the exact raw result for server-side submission', async () => {
  const fetcher = fixtureFetch('/api/search/audiobooks', searchFixture)
  const client = new LibrarrClient({ baseUrl: 'http://librarr:5050', apiKey: 'secret', fetcher })
  const results = await client.searchAudiobooks('Project Hail Mary')
  expect(results[0].info_hash).toBe('0123456789abcdef0123456789abcdef01234567')
  expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('q=Project+Hail+Mary'), expect.objectContaining({
    headers: expect.objectContaining({ 'x-api-key': 'secret' })
  }))
})
```

- [ ] **Step 3: Implement runtime schemas and adapter methods**

```ts
export const LibrarrSearchResultSchema = z.object({
  source: z.string(), title: z.string(), author: z.string().default(''), size: z.number().int().nonnegative().optional(),
  seeders: z.number().int().optional(), format: z.string().optional(), media_type: z.literal('audiobook'),
  info_hash: z.string().optional(), magnet_url: z.string().optional(), download_url: z.string().optional(),
  download_protocol: z.enum(['torrent', 'nzb']).optional(), guid: z.string().optional(), source_id: z.string().optional(),
  cover_url: z.string().optional(), in_library: z.boolean().default(false), library_item_id: z.union([z.string(), z.number()]).optional()
}).passthrough()

async searchAudiobooks(query: string) {
  return this.request('/api/search/audiobooks?' + new URLSearchParams({ q: query }), LibrarrSearchResponseSchema)
}

async submitAudiobook(result: LibrarrSearchResult) {
  return this.request('/api/download/audiobook', LibrarrSubmitResponseSchema, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(result)
  })
}
```

- [ ] **Step 4: Run adapter tests**

```bash
pnpm --filter @abs/acquisition-gateway test -- src/adapters/librarrClient.test.ts
```

Expected: PASS for search, submit, queue parsing, non-2xx sanitization, and API-key headers.

- [ ] **Step 5: Commit**

```bash
git add services/acquisition-gateway/src/adapters services/acquisition-gateway/test/fixtures/librarr
git commit -m "feat: adapt Librarr audiobook API"
```

### Task 2: Create opaque release snapshots

**Files:**
- Create: `services/acquisition-gateway/src/domain/releaseIdentity.ts`
- Create: `services/acquisition-gateway/src/services/searchService.ts`
- Create: `services/acquisition-gateway/src/routes/search.ts`
- Modify: `packages/acquisition-contract/src/index.ts`
- Modify: `packages/acquisition-client/src/index.ts`
- Test: `services/acquisition-gateway/src/services/searchService.test.ts`

- [ ] **Step 1: Write failing opacity and expiry tests**

```ts
it('returns opaque IDs and refuses an expired snapshot', async () => {
  const response = await service.search(user('u1'), 'lib1', 'Project Hail Mary')
  expect(response.searchSessionId).toMatch(/^search_[A-Za-z0-9_-]{22}$/)
  expect(response.results[0].releaseId).toMatch(/^release_[A-Za-z0-9_-]{22}$/)
  expect(JSON.stringify(response)).not.toContain('magnet:')
  clock.advanceBy(901_000)
  expect(() => service.resolveRelease('u1', response.searchSessionId, response.results[0].releaseId)).toThrowError('search_expired')
})
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm --filter @abs/acquisition-gateway test -- src/services/searchService.test.ts
```

Expected: FAIL because the search service is missing.

- [ ] **Step 3: Implement opaque IDs and safe DTO mapping**

```ts
export const opaqueId = (prefix: 'search' | 'release' | 'acq') => `${prefix}_${randomBytes(16).toString('base64url')}`

export function toPublicRelease(raw: LibrarrSearchResult): SearchRelease {
  return {
    releaseId: opaqueId('release'), title: raw.title, author: raw.author, narrators: [],
    format: raw.format ?? 'unknown', sizeBytes: raw.size ?? null, durationSeconds: null,
    sourceLabel: raw.source, qualityLabel: raw.format?.toUpperCase() ?? 'Unknown', seeders: raw.seeders ?? null,
    coverUrl: raw.cover_url ?? null, alreadyOwned: raw.in_library, existingAbsItemId: raw.library_item_id?.toString() ?? null
  }
}
```

Persist `{ releaseId, public, raw }[]` as `results_json`. Resolve only when `abs_user_id`, `abs_library_id`, session ID, release ID, and expiry all match.

- [ ] **Step 4: Run search route and schema tests**

```bash
pnpm --filter @abs/acquisition-gateway test -- src/services/searchService.test.ts
pnpm --filter @abs/acquisition-contract test
pnpm --filter @abs/acquisition-client test
```

Expected: all commands pass.

- [ ] **Step 5: Commit**

```bash
git add packages/acquisition-contract packages/acquisition-client services/acquisition-gateway/src/domain services/acquisition-gateway/src/services/searchService.ts services/acquisition-gateway/src/routes/search.ts
git commit -m "feat: issue opaque acquisition search results"
```

### Task 3: Submit one exact release idempotently

**Files:**
- Create: `services/acquisition-gateway/src/domain/librarrTrackingKey.ts`
- Create: `services/acquisition-gateway/src/services/acquisitionService.ts`
- Create: `services/acquisition-gateway/src/routes/acquisitions.ts`
- Modify: `packages/acquisition-contract/src/index.ts`
- Modify: `packages/acquisition-client/src/index.ts`
- Test: `services/acquisition-gateway/src/services/acquisitionService.test.ts`

- [ ] **Step 1: Write the failing duplicate-submission test**

```ts
it('creates one Librarr job for concurrent repeats of an idempotency key', async () => {
  const body = { searchSessionId: 'search_12345678', releaseId: 'release_12345678', idempotencyKey: '739ee1d7-438e-4b62-999c-ab109cc881df' }
  const [first, second] = await Promise.all([
    service.create(user('u1'), 'lib1', body), service.create(user('u1'), 'lib1', body)
  ])
  expect(first.id).toBe(second.id)
  expect(librarr.submitAudiobook).toHaveBeenCalledTimes(1)
})
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm --filter @abs/acquisition-gateway test -- src/services/acquisitionService.test.ts
```

Expected: FAIL because create/submission logic is missing.

- [ ] **Step 3: Implement transactional creation and tracking keys**

```ts
export function trackingKey(result: LibrarrSearchResult, submit: LibrarrSubmitResponse): string {
  if (submit.job_id) return `job:${submit.job_id}`
  if (submit.nzo_id) return `nzb:${submit.nzo_id}`
  const hash = normalizeInfoHash(result.info_hash ?? extractBtih(result.magnet_url ?? ''))
  if (hash) return `torrent:${hash}`
  throw new DomainError('release_not_trackable', 'Librarr did not provide a stable download identity', false)
}
```

Before displaying a torrent result as requestable, require an `info_hash` or a BTIH value extractable from its magnet. This prevents accepting an external job that the gateway cannot correlate. NZB results are requestable because Librarr returns `nzo_id`; if Librarr accepts one but omits that ID, persist `needs_attention` and never resubmit it automatically.

Within `BEGIN IMMEDIATE`: return an existing `(user,idempotencyKey)` row or insert `queued`. Submit only after a successful insert and successful tracking preflight, then persist `submitted` and the tracking key. On submission error, persist `failed` with `last_successful_stage='queued'`.

- [ ] **Step 4: Verify idempotency and exact payload tests**

```bash
pnpm --filter @abs/acquisition-gateway test -- src/services/acquisitionService.test.ts
```

Expected: PASS; captured submission body equals the selected raw snapshot entry byte-for-byte after JSON normalization.

- [ ] **Step 5: Commit**

```bash
git add packages/acquisition-contract packages/acquisition-client services/acquisition-gateway/src/domain/librarrTrackingKey.ts services/acquisition-gateway/src/services/acquisitionService.ts services/acquisition-gateway/src/routes/acquisitions.ts
git commit -m "feat: submit exact Librarr releases idempotently"
```

### Task 4: Normalize progress and reconcile restarts

**Files:**
- Create: `services/acquisition-gateway/src/domain/statusNormalization.ts`
- Create: `services/acquisition-gateway/src/services/reconciler.ts`
- Modify: `services/acquisition-gateway/src/main.ts`
- Test: `services/acquisition-gateway/src/domain/statusNormalization.test.ts`
- Test: `services/acquisition-gateway/src/services/reconciler.test.ts`

- [ ] **Step 1: Write failing state mapping tests**

```ts
it.each([
  ['queued', 0, 'submitted'], ['downloading', 72.4, 'downloading'], ['importing', 100, 'processing'],
  ['error', 150, 'failed'], ['dead_letter', -2, 'failed'], ['completed', 100, 'processing']
])('maps %s to %s', (status, progress, expected) => {
  expect(normalizeLibrarrStatus({ status, progress })).toMatchObject({ state: expected, progressPercent: Math.min(100, Math.max(0, progress)) })
})
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm --filter @abs/acquisition-gateway test -- src/domain/statusNormalization.test.ts src/services/reconciler.test.ts
```

Expected: FAIL because normalization and reconciliation are missing.

- [ ] **Step 3: Implement monotonic reconciliation**

```ts
const ranks = { queued: 0, submitted: 1, downloading: 2, processing: 3, staged: 4, importing: 5, scanning: 6, available: 7 } as const

export function mayAdvance(from: AcquisitionState, to: AcquisitionState): boolean {
  if (to === 'failed' || to === 'needs_attention' || to === 'cancelled') return true
  if (!(from in ranks) || !(to in ranks)) return false
  return ranks[to as keyof typeof ranks] >= ranks[from as keyof typeof ranks]
}
```

At process start, block mutation routes, load all nonterminal acquisitions, fetch `/api/downloads`, inspect tracking keys, persist valid advances, then enable mutations. Poll every configured interval with a single-flight guard.

During the same maintenance cycle, delete expired unreferenced search sessions and terminal acquisition rows older than the configured history-retention window. Never delete a search session still referenced by an acquisition row.

- [ ] **Step 4: Verify restart scenarios**

```bash
pnpm --filter @abs/acquisition-gateway test -- src/domain/statusNormalization.test.ts src/services/reconciler.test.ts
```

Expected: PASS for missing-job-with-staging, missing-job-without-staging, completed download, regressive provider status, and clamped progress.

- [ ] **Step 5: Commit**

```bash
git add services/acquisition-gateway/src/domain/statusNormalization.ts services/acquisition-gateway/src/services/reconciler.ts services/acquisition-gateway/src/main.ts
git commit -m "feat: reconcile Librarr acquisition progress"
```

### Task 5: Add retry, cancel, queue, and SSE

**Files:**
- Create: `services/acquisition-gateway/src/events/eventBus.ts`
- Create: `services/acquisition-gateway/src/routes/events.ts`
- Modify: `services/acquisition-gateway/src/routes/acquisitions.ts`
- Modify: `packages/acquisition-contract/src/index.ts`
- Modify: `packages/acquisition-client/src/index.ts`
- Test: `services/acquisition-gateway/src/routes/acquisitions.test.ts`
- Test: `services/acquisition-gateway/src/routes/events.test.ts`

- [ ] **Step 1: Write failing authorization and replay tests**

```ts
it('never exposes another user queue and replays events after Last-Event-ID', async () => {
  await seedAcquisition({ id: 'a1', absUserId: 'u1' })
  await seedAcquisition({ id: 'a2', absUserId: 'u2' })
  expect(await listAs('u1')).toEqual([expect.objectContaining({ id: 'a1' })])
  eventBus.publish('u1', { type: 'acquisition.updated', acquisitionId: 'a1' })
  expect(eventBus.after('u1', '0')).toHaveLength(1)
  expect(eventBus.after('u2', '0')).toHaveLength(0)
})
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm --filter @abs/acquisition-gateway test -- src/routes/acquisitions.test.ts src/routes/events.test.ts
```

Expected: FAIL because mutation and event routes are incomplete.

- [ ] **Step 3: Implement guarded mutations and replayable events**

```ts
export type AcquisitionEvent = {
  id: string
  type: 'acquisition.created' | 'acquisition.updated'
  acquisitionId: string
  occurredAt: string
}
```

Retry resumes from `lastSuccessfulStage`; retrying download calls Librarr once, while retrying `scanning` or resolution never calls Librarr. Cancel calls the matching Librarr delete endpoint only for active `job:`, `nzb:`, or `torrent:` keys and always preserves final imported content. Keep the last 100 events per user in memory and emit SSE `id`, `event`, and JSON `data` fields.

`GET /acquisitions/:acquisitionId` uses the same user ownership filter as list, retry, and cancel; a missing or foreign acquisition returns the same `404 acquisition_not_found` response so IDs cannot be enumerated.

- [ ] **Step 4: Run the flow suite**

```bash
pnpm --filter @abs/acquisition-gateway test
pnpm --filter @abs/acquisition-contract test
pnpm --filter @abs/acquisition-client test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/acquisition-contract packages/acquisition-client services/acquisition-gateway/src/events services/acquisition-gateway/src/routes services/acquisition-gateway/src/services
git commit -m "feat: expose acquisition queue lifecycle"
```
