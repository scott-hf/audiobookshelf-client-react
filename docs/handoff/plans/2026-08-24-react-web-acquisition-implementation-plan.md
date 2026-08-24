# React Web Acquisition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add responsive Discover, acquisition queue, and gateway status experiences to the existing Next.js client.

**Architecture:** Browser components call the same-origin `/acquisition-api/v1` API through the shared typed client; HTTP-only ABS cookies authenticate automatically. A small provider caches gateway status and queue state, uses SSE for immediacy, and polls as recovery without touching ABS Socket.IO.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, next-intl, Tailwind 4, shared Zod contract, Cypress 15

---

## File Map

| Path | Responsibility |
|---|---|
| `src/lib/acquisition.ts` | Browser client singleton and error formatting |
| `src/contexts/AcquisitionContext.tsx` | Status, queue cache, SSE, polling fallback |
| `src/components/acquisition/ReleaseCard.tsx` | Exact release presentation and Acquire action |
| `src/components/acquisition/AcquisitionRow.tsx` | Queue state, progress, retry, cancel, Open Book |
| `src/app/(main)/library/[library]/discover/` | Search route and client screen |
| `src/app/(main)/library/[library]/acquisition-queue/` | Queue route and client screen |
| `src/app/(main)/settings/acquisition/` | Secret-free gateway diagnostics |
| `src/app/(main)/SideRailContent.tsx` | Conditional Discover navigation |
| `src/locales/en-us.json` | Canonical acquisition translations |

### Task 1: Complete the browser client and provider

**Files:**
- Modify: `packages/acquisition-client/src/index.ts`
- Modify: `Dockerfile`
- Create: `src/lib/acquisition.ts`
- Create: `src/contexts/AcquisitionContext.tsx`
- Modify: `src/app/(main)/layout.tsx`
- Test: `cypress/tests/components/acquisition/AcquisitionProvider.cy.tsx`

- [ ] **Step 1: Write the failing provider test**

```tsx
it('loads status and falls back to polling after an SSE error', () => {
  cy.clock()
  cy.intercept('GET', '/acquisition-api/v1/status', { version: '1.0.0', ready: true, libraries: [{ id: 'lib1', enabled: true }] }).as('status')
  cy.intercept('GET', '/acquisition-api/v1/libraries/lib1/acquisitions', { acquisitions: [] }).as('queue')
  cy.mount(<AcquisitionProvider><Probe libraryId="lib1" /></AcquisitionProvider>)
  cy.wait('@status')
  cy.get('[data-testid=acquisition-enabled]').should('contain', 'true')
  cy.window().then((win) => win.dispatchEvent(new CustomEvent('test-acquisition-sse-error')))
  cy.tick(10_000)
  cy.wait('@queue')
})
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm test:spec --spec cypress/tests/components/acquisition/AcquisitionProvider.cy.tsx
```

Expected: FAIL because the provider does not exist.

- [ ] **Step 3: Add client methods and provider state**

```ts
return {
  status: () => request<GatewayStatus>('/status'),
  search: (libraryId: string, query: string) => request<SearchResponse>(`/libraries/${encodeURIComponent(libraryId)}/search?${new URLSearchParams({ q: query })}`),
  create: (libraryId: string, body: CreateAcquisitionBody) => request<Acquisition>(`/libraries/${encodeURIComponent(libraryId)}/acquisitions`, json('POST', body)),
  list: (libraryId: string) => request<{ acquisitions: Acquisition[] }>(`/libraries/${encodeURIComponent(libraryId)}/acquisitions`),
  retry: (id: string) => request<Acquisition>(`/acquisitions/${encodeURIComponent(id)}/retry`, { method: 'POST' }),
  cancel: (id: string) => request<Acquisition>(`/acquisitions/${encodeURIComponent(id)}/cancel`, { method: 'POST' })
}
```

The provider loads status once, exposes `isLibraryEnabled(id)`, stores queues by library ID, opens `EventSource('/acquisition-api/v1/events')`, refreshes the affected queue on an acquisition event, and polls active queues every 10 seconds only while SSE is disconnected.

Update the existing React image build stage to copy `pnpm-workspace.yaml` and `packages/` before installation so the root Next build resolves both shared workspace packages:

```dockerfile
COPY --from=abs-client package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY --from=abs-client packages ./packages
COPY --from=abs-client scripts ./scripts
RUN pnpm install --frozen-lockfile
```

- [ ] **Step 4: Run provider and shared-client tests**

```bash
pnpm --filter @abs/acquisition-client test
pnpm test:spec --spec cypress/tests/components/acquisition/AcquisitionProvider.cy.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/acquisition-client Dockerfile src/lib/acquisition.ts src/contexts/AcquisitionContext.tsx 'src/app/(main)/layout.tsx' cypress/tests/components/acquisition/AcquisitionProvider.cy.tsx
git commit -m "feat: provide web acquisition state"
```

### Task 2: Add conditional Discover navigation

**Files:**
- Modify: `src/app/(main)/SideRailContent.tsx`
- Modify: `src/app/(main)/library/[library]/LibraryLayoutWrapper.tsx`
- Modify: `src/locales/en-us.json`
- Test: `cypress/tests/components/acquisition/SideRailAcquisition.cy.tsx`

- [ ] **Step 1: Write the failing visibility test**

```tsx
it('shows Discover only for an enabled book library', () => {
  mountSideRail({ mediaType: 'book', enabledLibraries: ['lib1'], libraryId: 'lib1' })
  cy.findByRole('link', { name: 'Discover' }).should('have.attr', 'href', '/library/lib1/discover')
  mountSideRail({ mediaType: 'podcast', enabledLibraries: ['lib1'], libraryId: 'lib1' })
  cy.findByRole('link', { name: 'Discover' }).should('not.exist')
})
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm test:spec --spec cypress/tests/components/acquisition/SideRailAcquisition.cy.tsx
```

Expected: FAIL because Discover is not registered.

- [ ] **Step 3: Add the navigation item**

```tsx
const { isLibraryEnabled } = useAcquisition()
if (mediaType === 'book' && isLibraryEnabled(libraryId)) {
  buttons.splice(3, 0, {
    icon: <span className="material-symbols text-2xl">travel_explore</span>,
    label: t('ButtonDiscover'),
    href: `/library/${libraryId}/discover`,
    mediaType: 'book' as const
  })
}
```

Exclude `/discover` and `/acquisition-queue` from the bookshelf toolbar and cover-size widget in `LibraryLayoutWrapper`.

- [ ] **Step 4: Run navigation tests and hardcoded-string check**

```bash
pnpm test:spec --spec cypress/tests/components/acquisition/SideRailAcquisition.cy.tsx
pnpm find-hardcoded-strings
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add 'src/app/(main)/SideRailContent.tsx' 'src/app/(main)/library/[library]/LibraryLayoutWrapper.tsx' src/locales/en-us.json cypress/tests/components/acquisition/SideRailAcquisition.cy.tsx
git commit -m "feat: add acquisition navigation"
```

### Task 3: Build Discover search and confirmation

**Files:**
- Create: `src/components/acquisition/ReleaseCard.tsx`
- Create: `src/app/(main)/library/[library]/discover/page.tsx`
- Create: `src/app/(main)/library/[library]/discover/DiscoverClient.tsx`
- Modify: `src/locales/en-us.json`
- Test: `cypress/tests/components/acquisition/DiscoverClient.cy.tsx`

- [ ] **Step 1: Write the failing search/acquire test**

```tsx
it('submits the exact opaque release after confirmation', () => {
  const api = fakeApi({ searchSessionId: 'search_12345678', results: [release({ releaseId: 'release_12345678', format: 'm4b', sizeBytes: 742000000 })] })
  cy.mount(<DiscoverClient libraryId="lib1" api={api} />)
  cy.findByLabelText('Search audiobooks').type('Project Hail Mary')
  cy.findByRole('button', { name: 'Search' }).click()
  cy.findByText('M4B').should('exist')
  cy.findByRole('button', { name: 'Acquire' }).click()
  cy.findByRole('button', { name: 'Confirm acquisition' }).click()
  cy.wrap(api.create).should('have.been.calledWith', 'lib1', expect.objectContaining({ searchSessionId: 'search_12345678', releaseId: 'release_12345678' }))
})
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm test:spec --spec cypress/tests/components/acquisition/DiscoverClient.cy.tsx
```

Expected: FAIL because Discover components are missing.

- [ ] **Step 3: Implement the mobile-first search screen**

```tsx
const handleAcquire = async () => {
  if (!selected || !results) return
  setSubmitting(selected.releaseId)
  try {
    await api.create(libraryId, {
      searchSessionId: results.searchSessionId,
      releaseId: selected.releaseId,
      idempotencyKey: crypto.randomUUID()
    })
    showToast(t('MessageAcquisitionQueued'), { type: 'success' })
    router.push(`/library/${libraryId}/acquisition-queue`)
  } finally {
    setSubmitting(null)
    setSelected(null)
  }
}
```

Render format, size, duration, source, seeders, quality, author, narrator, owned state, and disabled in-flight state. Use `TextInput`, `Btn`, `Pill`, `PageMessage`, `ConfirmDialog`, and existing responsive spacing tokens.

- [ ] **Step 4: Run component, lint, and translation checks**

```bash
pnpm test:spec --spec cypress/tests/components/acquisition/DiscoverClient.cy.tsx
pnpm lint
pnpm find-hardcoded-strings
```

Expected: all commands pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/acquisition/ReleaseCard.tsx 'src/app/(main)/library/[library]/discover' src/locales/en-us.json cypress/tests/components/acquisition/DiscoverClient.cy.tsx
git commit -m "feat: add audiobook discovery screen"
```

### Task 4: Build the acquisition queue

**Files:**
- Create: `src/components/acquisition/AcquisitionRow.tsx`
- Create: `src/app/(main)/library/[library]/acquisition-queue/page.tsx`
- Create: `src/app/(main)/library/[library]/acquisition-queue/AcquisitionQueueClient.tsx`
- Modify: `src/locales/en-us.json`
- Test: `cypress/tests/components/acquisition/AcquisitionQueueClient.cy.tsx`

- [ ] **Step 1: Write the failing queue behavior test**

```tsx
it('clamps progress and opens only a confirmed ABS item', () => {
  cy.mount(<AcquisitionQueueClient libraryId="lib1" initial={[acquisition({ id: 'a1', state: 'downloading', progressPercent: 120 })]} />)
  cy.findByText('100%').should('exist')
  cy.findByRole('link', { name: 'Open Book' }).should('not.exist')
  cy.mount(<AcquisitionQueueClient libraryId="lib1" initial={[acquisition({ id: 'a1', state: 'available', absItemId: 'abs1' })]} />)
  cy.findByRole('link', { name: 'Open Book' }).should('have.attr', 'href', '/library/lib1/item/abs1')
})
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm test:spec --spec cypress/tests/components/acquisition/AcquisitionQueueClient.cy.tsx
```

Expected: FAIL because queue components are missing.

- [ ] **Step 3: Implement queue rows and mutations**

```tsx
const progress = acquisition.progressPercent == null ? null : Math.min(100, Math.max(0, acquisition.progressPercent))
const canOpen = acquisition.state === 'available' && !!acquisition.absItemId
const canRetry = acquisition.state === 'failed' && acquisition.error?.retryable === true
const canCancel = ['queued', 'submitted', 'downloading', 'processing', 'staged'].includes(acquisition.state)
```

Display readable status, indeterminate progress when null, error code/message, retry/cancel confirmation, and active/recent state groups.

- [ ] **Step 4: Run the queue suite**

```bash
pnpm test:spec --spec cypress/tests/components/acquisition/AcquisitionQueueClient.cy.tsx
```

Expected: PASS for clamping, indeterminate progress, retry, cancel, errors, and Open Book.

- [ ] **Step 5: Commit**

```bash
git add src/components/acquisition/AcquisitionRow.tsx 'src/app/(main)/library/[library]/acquisition-queue' src/locales/en-us.json cypress/tests/components/acquisition/AcquisitionQueueClient.cy.tsx
git commit -m "feat: add acquisition queue screen"
```

### Task 5: Add secret-free gateway diagnostics

**Files:**
- Create: `src/app/(main)/settings/acquisition/page.tsx`
- Create: `src/app/(main)/settings/acquisition/AcquisitionSettingsClient.tsx`
- Modify: `src/app/(main)/settings/settingsNavItems.ts`
- Modify: `src/locales/en-us.json`
- Test: `cypress/tests/components/acquisition/AcquisitionSettingsClient.cy.tsx`

- [ ] **Step 1: Write the failing redaction test**

```tsx
it('shows readiness without credential controls', () => {
  cy.mount(<AcquisitionSettingsClient status={status({ ready: true, librarr: { reachable: true }, staging: { ready: true } })} />)
  cy.findByText('Connected').should('exist')
  cy.findByLabelText(/API key/i).should('not.exist')
  cy.findByLabelText(/token/i).should('not.exist')
})
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm test:spec --spec cypress/tests/components/acquisition/AcquisitionSettingsClient.cy.tsx
```

Expected: FAIL because diagnostics are missing.

- [ ] **Step 3: Implement the settings route**

Add `HeaderAcquisition` to `SettingsNavItemDef` and `SETTINGS_NAV_ITEMS`. Render version, gateway readiness, Librarr reachability, staging readiness, and enabled library IDs. Render no editable secrets.

```tsx
<SettingsContent title={t('HeaderAcquisition')}>
  <StatusRow label={t('LabelGateway')} healthy={status.ready} />
  <StatusRow label={t('LabelLibrarr')} healthy={status.librarr.reachable} />
  <StatusRow label={t('LabelStaging')} healthy={status.staging.ready} />
</SettingsContent>
```

- [ ] **Step 4: Run tests and typecheck**

```bash
pnpm test:spec --spec cypress/tests/components/acquisition/AcquisitionSettingsClient.cy.tsx
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add 'src/app/(main)/settings/acquisition' 'src/app/(main)/settings/settingsNavItems.ts' src/locales/en-us.json cypress/tests/components/acquisition/AcquisitionSettingsClient.cy.tsx
git commit -m "feat: show acquisition gateway diagnostics"
```

### Task 6: Add the full browser journey

**Files:**
- Modify: `cypress.config.ts`
- Create: `cypress/e2e/acquisition.cy.ts`
- Create: `cypress/fixtures/acquisition/search.json`
- Create: `cypress/fixtures/acquisition/queue.json`

- [ ] **Step 1: Configure an E2E project**

```ts
e2e: {
  baseUrl: 'http://localhost:3000',
  specPattern: 'cypress/e2e/**/*.cy.ts',
  supportFile: false
}
```

- [ ] **Step 2: Write the complete journey**

```ts
it('searches, acquires, tracks, and opens the imported book', () => {
  cy.loginByApi()
  cy.intercept('GET', '/acquisition-api/v1/libraries/lib1/search*', { fixture: 'acquisition/search.json' })
  cy.intercept('POST', '/acquisition-api/v1/libraries/lib1/acquisitions', { statusCode: 201, body: { id: 'a1', state: 'queued' } })
  cy.intercept('GET', '/acquisition-api/v1/libraries/lib1/acquisitions', { fixture: 'acquisition/queue.json' })
  cy.visit('/library/lib1/discover')
  cy.findByLabelText('Search audiobooks').type('Project Hail Mary{enter}')
  cy.findByRole('button', { name: 'Acquire' }).first().click()
  cy.findByRole('button', { name: 'Confirm acquisition' }).click()
  cy.findByRole('link', { name: 'Open Book' }).should('have.attr', 'href', '/library/lib1/item/abs1')
})
```

- [ ] **Step 3: Run the Next app and E2E spec**

```bash
pnpm build
pnpm start
```

In a second shell:

```bash
pnpm cypress run --e2e --browser chrome --spec cypress/e2e/acquisition.cy.ts
```

Expected: PASS at desktop and `iphone-x` viewports.

- [ ] **Step 4: Run the complete web quality gate**

```bash
pnpm check
pnpm test
```

Expected: all existing and acquisition checks pass.

- [ ] **Step 5: Commit**

```bash
git add cypress.config.ts cypress/e2e cypress/fixtures/acquisition
git commit -m "test: cover web acquisition journey"
```
