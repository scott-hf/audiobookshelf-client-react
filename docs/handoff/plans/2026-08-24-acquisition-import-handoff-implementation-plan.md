# Acquisition Import Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move completed Librarr output safely from staging into the selected Audiobookshelf library, trigger a scan, and resolve exactly one ABS item ID.

**Architecture:** Librarr organizes completed content under the configured staging root and does not know ABS credentials. The gateway validates a stable staged tree, performs an atomic rename or verified temporary copy, invokes supported ABS APIs, and persists every recovery boundary.

**Tech Stack:** Node filesystem APIs, SQLite, Fastify, Audiobookshelf HTTP API, Vitest, Docker Compose

---

## File Map

| Path | Responsibility |
|---|---|
| `services/acquisition-gateway/src/domain/safePath.ts` | Root confinement and sanitized destinations |
| `services/acquisition-gateway/src/services/stagingInspector.ts` | Stable supported-file discovery |
| `services/acquisition-gateway/src/services/fileHandoff.ts` | Atomic rename and verified cross-device copy |
| `services/acquisition-gateway/src/adapters/absAdminClient.ts` | Scan and item query operations |
| `services/acquisition-gateway/src/services/importResolver.ts` | Evidence-based ABS item matching |
| `services/acquisition-gateway/src/services/importCoordinator.ts` | Durable staged-to-available state machine |
| `deploy/acquisition/docker-compose.test.yml` | Disposable integration environment |

### Task 1: Confine staging and destination paths

**Files:**
- Create: `services/acquisition-gateway/src/domain/safePath.ts`
- Test: `services/acquisition-gateway/src/domain/safePath.test.ts`

- [ ] **Step 1: Write traversal and symlink tests**

```ts
it.each(['../escape', '/absolute', 'Author/../../escape'])('rejects %s', (candidate) => {
  expect(() => resolveUnder('/media/library', candidate)).toThrow('path_outside_root')
})

it('creates a deterministic safe author/title destination', () => {
  expect(bookDestination('/media/library', 'Andy/Weir', 'Project: Hail Mary')).toBe('/media/library/Andy Weir/Project - Hail Mary')
})
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm --filter @abs/acquisition-gateway test -- src/domain/safePath.test.ts
```

Expected: FAIL because safe-path helpers are missing.

- [ ] **Step 3: Implement root confinement**

```ts
export function resolveUnder(root: string, relative: string): string {
  if (path.isAbsolute(relative)) throw new DomainError('path_outside_root', 'Absolute paths are forbidden', false)
  const base = path.resolve(root)
  const candidate = path.resolve(base, relative)
  if (candidate === base || !candidate.startsWith(base + path.sep)) throw new DomainError('path_outside_root', 'Path escapes configured root', false)
  return candidate
}

export const sanitizeSegment = (value: string) => value.replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Unknown'
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @abs/acquisition-gateway test -- src/domain/safePath.test.ts
```

Expected: PASS, including symlink-realpath confinement tests.

- [ ] **Step 5: Commit**

```bash
git add services/acquisition-gateway/src/domain/safePath.ts services/acquisition-gateway/src/domain/safePath.test.ts
git commit -m "feat: confine acquisition filesystem paths"
```

### Task 2: Detect a stable staged audiobook

**Files:**
- Create: `services/acquisition-gateway/src/services/stagingInspector.ts`
- Test: `services/acquisition-gateway/src/services/stagingInspector.test.ts`

- [ ] **Step 1: Write failing stability tests**

```ts
it('requires a supported file and two identical observations', async () => {
  await fs.mkdir(join(root, 'Andy Weir', 'Project Hail Mary'), { recursive: true })
  await fs.writeFile(join(root, 'Andy Weir', 'Project Hail Mary', 'book.m4b'), Buffer.alloc(32))
  const first = await inspector.observe(candidate)
  expect(first.stable).toBe(false)
  clock.advanceBy(5_000)
  const second = await inspector.observe(candidate)
  expect(second).toMatchObject({ stable: true, totalBytes: 32, audioFileCount: 1 })
})
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm --filter @abs/acquisition-gateway test -- src/services/stagingInspector.test.ts
```

Expected: FAIL because the inspector does not exist.

- [ ] **Step 3: Implement recursive observations**

Supported audio extensions are `.m4b`, `.mp3`, `.m4a`, `.aac`, `.flac`, `.ogg`, `.opus`, and `.wav`. Reject symlinks, sockets, device files, empty audio sets, and trees outside staging. Build a fingerprint from sorted relative path, byte size, and `mtimeMs`; require the same fingerprint after `STAGING_STABILITY_SECONDS`.

```ts
type StagingObservation = {
  root: string
  fingerprint: string
  totalBytes: number
  audioFileCount: number
  stable: boolean
}
```

- [ ] **Step 4: Verify the inspector**

```bash
pnpm --filter @abs/acquisition-gateway test -- src/services/stagingInspector.test.ts
```

Expected: PASS for changing files, unsupported trees, symlinks, nested files, and stable output.

- [ ] **Step 5: Commit**

```bash
git add services/acquisition-gateway/src/services/stagingInspector.ts services/acquisition-gateway/src/services/stagingInspector.test.ts
git commit -m "feat: validate staged audiobook output"
```

### Task 3: Perform atomic or verified handoff

**Files:**
- Create: `services/acquisition-gateway/src/services/fileHandoff.ts`
- Test: `services/acquisition-gateway/src/services/fileHandoff.test.ts`

- [ ] **Step 1: Write failing rename and EXDEV tests**

```ts
it('copies to a hidden temp tree on EXDEV and exposes only the final rename', async () => {
  fsAdapter.rename.mockRejectedValueOnce(Object.assign(new Error('cross device'), { code: 'EXDEV' }))
  await handoff.move(source, destination)
  expect(fsAdapter.copyTree).toHaveBeenCalledWith(source, expect.stringMatching(/\.importing-a1$/))
  expect(fsAdapter.verifyTree).toHaveBeenCalled()
  expect(fsAdapter.rename).toHaveBeenLastCalledWith(expect.stringMatching(/\.importing-a1$/), destination)
  expect(await exists(destination)).toBe(true)
})
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm --filter @abs/acquisition-gateway test -- src/services/fileHandoff.test.ts
```

Expected: FAIL because handoff is missing.

- [ ] **Step 3: Implement idempotent handoff**

```ts
try {
  await fs.rename(source, destination)
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
  const temporary = join(dirname(destination), `.importing-${acquisitionId}`)
  await copyTreeNoSymlinks(source, temporary)
  await verifySameTree(source, temporary)
  await fs.rename(temporary, destination)
  await fs.rm(source, { recursive: true })
}
```

If `destination` already exists, verify it matches the persisted acquisition before treating the side effect as complete. Never merge into a pre-existing unrelated directory.

- [ ] **Step 4: Run interruption tests**

```bash
pnpm --filter @abs/acquisition-gateway test -- src/services/fileHandoff.test.ts
```

Expected: PASS for atomic rename, EXDEV, interrupted copy cleanup, destination collision, byte mismatch, and restart after final rename.

- [ ] **Step 5: Commit**

```bash
git add services/acquisition-gateway/src/services/fileHandoff.ts services/acquisition-gateway/src/services/fileHandoff.test.ts
git commit -m "feat: hand off staged audiobooks safely"
```

### Task 4: Add supported ABS scan and item queries

**Files:**
- Create: `services/acquisition-gateway/src/adapters/absAdminSchemas.ts`
- Create: `services/acquisition-gateway/src/adapters/absAdminClient.ts`
- Create: `services/acquisition-gateway/test/fixtures/abs/library-items.json`
- Test: `services/acquisition-gateway/src/adapters/absAdminClient.test.ts`

- [ ] **Step 1: Write failing request-shape tests**

```ts
it('scans one library and queries only that library', async () => {
  await client.scanLibrary('lib1')
  await client.listLibraryItems('lib1', { limit: 100, page: 0 })
  expect(fetcher).toHaveBeenNthCalledWith(1, 'http://abs:13378/api/libraries/lib1/scan', expect.objectContaining({ method: 'POST' }))
  expect(fetcher).toHaveBeenNthCalledWith(2, expect.stringContaining('/api/libraries/lib1/items?'), expect.anything())
})
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm --filter @abs/acquisition-gateway test -- src/adapters/absAdminClient.test.ts
```

Expected: FAIL because the adapter is missing.

- [ ] **Step 3: Implement the ABS admin adapter**

```ts
private async request(path: string, init: RequestInit = {}) {
  const response = await this.fetcher(`${this.baseUrl}${path}`, {
    ...init, headers: { ...init.headers, authorization: `Bearer ${this.serviceToken}`, accept: 'application/json' }
  })
  if (!response.ok) throw new UpstreamError('abs_error', response.status)
  return response.status === 204 ? undefined : response.json()
}
```

Parse item ID, library ID, path/relative path, added timestamp, title, author, ISBN/ASIN when present, and media metadata. Never return the service token in thrown errors.

- [ ] **Step 4: Run adapter tests**

```bash
pnpm --filter @abs/acquisition-gateway test -- src/adapters/absAdminClient.test.ts
```

Expected: PASS for scan, paging, schema drift rejection, timeout, and redaction.

- [ ] **Step 5: Commit**

```bash
git add services/acquisition-gateway/src/adapters/absAdminClient.ts services/acquisition-gateway/src/adapters/absAdminSchemas.ts services/acquisition-gateway/test/fixtures/abs
git commit -m "feat: add Audiobookshelf import adapter"
```

### Task 5: Resolve exactly one imported item

**Files:**
- Create: `services/acquisition-gateway/src/services/importResolver.ts`
- Test: `services/acquisition-gateway/src/services/importResolver.test.ts`

- [ ] **Step 1: Write evidence-scoring tests**

```ts
it('prefers exact path and refuses equal plausible matches', () => {
  expect(resolveImportedItem(evidence, [item({ id: 'exact', path: evidence.finalPath }), item({ id: 'title', title: evidence.title })])?.id).toBe('exact')
  expect(() => resolveImportedItem(evidence, [item({ id: 'a', title: evidence.title, author: evidence.author }), item({ id: 'b', title: evidence.title, author: evidence.author })])).toThrow('ambiguous_import')
})
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm --filter @abs/acquisition-gateway test -- src/services/importResolver.test.ts
```

Expected: FAIL because the resolver is missing.

- [ ] **Step 3: Implement ordered evidence**

```ts
const score = (item: AbsLibraryItem, evidence: ImportEvidence) =>
  (samePath(item, evidence.finalPath) ? 1000 : 0) +
  (sameLibrary(item, evidence.libraryId) ? 100 : 0) +
  (sameIdentifier(item, evidence.identifiers) ? 80 : 0) +
  (sameTitle(item, evidence.title) ? 30 : 0) +
  (sameAuthor(item, evidence.author) ? 20 : 0) +
  (insideScanWindow(item, evidence.scanStartedAt) ? 10 : 0)
```

Require exact path, or a unique score of at least `150`. A tie or sub-threshold result returns `needs_attention`; title-only never qualifies.

- [ ] **Step 4: Run resolver tests**

```bash
pnpm --filter @abs/acquisition-gateway test -- src/services/importResolver.test.ts
```

Expected: PASS for exact path, strong ID, title/author/time, ambiguity, and title-only rejection.

- [ ] **Step 5: Commit**

```bash
git add services/acquisition-gateway/src/services/importResolver.ts services/acquisition-gateway/src/services/importResolver.test.ts
git commit -m "feat: resolve imported Audiobookshelf items"
```

### Task 6: Coordinate staged-to-available recovery

**Files:**
- Create: `services/acquisition-gateway/src/services/importCoordinator.ts`
- Modify: `services/acquisition-gateway/src/services/reconciler.ts`
- Test: `services/acquisition-gateway/src/services/importCoordinator.test.ts`
- Create: `deploy/acquisition/docker-compose.test.yml`
- Create: `services/acquisition-gateway/test/e2e/importJourney.test.ts`

- [ ] **Step 1: Write the failing lifecycle test**

```ts
it('persists every boundary and never redownloads after scan failure', async () => {
  await coordinator.advance(acquisition('processing'))
  expect(repo.states()).toEqual(['staged', 'importing', 'scanning', 'failed'])
  expect(librarr.submitAudiobook).not.toHaveBeenCalled()
  abs.scanLibrary.mockResolvedValueOnce(undefined)
  abs.listLibraryItems.mockResolvedValueOnce([item({ id: 'abs1', path: finalPath })])
  await coordinator.retry(repo.get('a1'))
  expect(repo.get('a1')).toMatchObject({ state: 'available', absItemId: 'abs1' })
})
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm --filter @abs/acquisition-gateway test -- src/services/importCoordinator.test.ts
```

Expected: FAIL because the coordinator is missing.

- [ ] **Step 3: Implement the coordinator transitions**

```ts
switch (record.state) {
  case 'processing': return inspectAndPersistStaged(record)
  case 'staged': return persistImportingThenHandoff(record)
  case 'importing': return reconcileDestinationThenPersistScanning(record)
  case 'scanning': return scanAndResolve(record)
  case 'failed': return retryFrom(record.lastSuccessfulStage)
}
```

Emit one user-scoped update after every persisted transition. Set `completed_at` only with `state='available'` or other terminal states.

- [ ] **Step 4: Run unit and disposable-volume integration tests**

```bash
pnpm --filter @abs/acquisition-gateway test
docker compose -f deploy/acquisition/docker-compose.test.yml up --build --abort-on-container-exit gateway-e2e
```

Expected: all tests pass; the final item appears only after the hidden/atomic handoff and resolves to one fake ABS item ID.

- [ ] **Step 5: Commit**

```bash
git add services/acquisition-gateway/src/services services/acquisition-gateway/test/e2e deploy/acquisition/docker-compose.test.yml
git commit -m "feat: complete restart-safe acquisition imports"
```
