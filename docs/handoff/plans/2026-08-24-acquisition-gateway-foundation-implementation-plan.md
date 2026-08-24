# Acquisition Gateway Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish a versioned shared contract and a separately deployable gateway with validated configuration, SQLite persistence, ABS-backed authentication, and an authenticated status endpoint.

**Architecture:** Convert the fork to a pnpm workspace without moving the existing Next app. Shared Zod schemas live in `packages/acquisition-contract`; the Fastify service consumes them directly and stores gateway-owned correlation state in SQLite.

**Tech Stack:** pnpm workspaces, TypeScript 5, Zod, Fastify 5, better-sqlite3, Vitest, Pino, Docker

---

## File Map

| Path | Responsibility |
|---|---|
| `pnpm-workspace.yaml` | Workspace membership |
| `packages/acquisition-contract/src/index.ts` | Public DTOs, states, and errors |
| `packages/acquisition-client/src/index.ts` | Transport-neutral typed HTTP client |
| `services/acquisition-gateway/src/config.ts` | Environment parsing and library mappings |
| `services/acquisition-gateway/src/db/` | SQLite connection, migrations, repositories |
| `services/acquisition-gateway/src/auth/absAuth.ts` | Cookie/bearer extraction and ABS validation |
| `services/acquisition-gateway/src/routes/status.ts` | Authenticated capability endpoint |
| `services/acquisition-gateway/src/app.ts` | Fastify composition root |
| `services/acquisition-gateway/src/main.ts` | Process entry point and shutdown |

### Task 1: Create the workspace and contract package

**Files:**
- Create: `pnpm-workspace.yaml`
- Modify: `package.json`
- Create: `packages/acquisition-contract/package.json`
- Create: `packages/acquisition-contract/tsconfig.json`
- Create: `packages/acquisition-contract/src/index.ts`
- Test: `packages/acquisition-contract/src/index.test.ts`

- [ ] **Step 1: Write the contract test**

```ts
import { describe, expect, it } from 'vitest'
import { AcquisitionSchema, CreateAcquisitionBodySchema } from './index'

describe('acquisition contract', () => {
  it('rejects progress outside 0..100', () => {
    expect(() => AcquisitionSchema.parse({
      id: 'a1', libraryId: 'lib1', title: 'Book', author: 'Author', state: 'downloading',
      progressPercent: 101, createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z'
    })).toThrow()
  })

  it('requires opaque release identity and idempotency', () => {
    expect(CreateAcquisitionBodySchema.parse({
      searchSessionId: 'search_12345678', releaseId: 'release_12345678', idempotencyKey: crypto.randomUUID()
    })).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
pnpm --filter @abs/acquisition-contract test
```

Expected: FAIL because the workspace package and schemas do not exist.

- [ ] **Step 3: Add workspace configuration and schemas**

```yaml
# pnpm-workspace.yaml
packages:
  - packages/*
  - services/*
  - mobile
```

Add root scripts:

```json
{
  "scripts": {
    "test:workspace": "pnpm -r --if-present test",
    "typecheck:workspace": "pnpm -r --if-present typecheck"
  }
}
```

Use this contract core:

```ts
import { z } from 'zod'

export const AcquisitionStateSchema = z.enum([
  'queued', 'submitted', 'downloading', 'processing', 'staged', 'importing',
  'scanning', 'available', 'failed', 'cancelled', 'needs_attention'
])

export const GatewayErrorSchema = z.object({
  code: z.string(), message: z.string(), retryable: z.boolean(), lastSuccessfulStage: z.string().nullable()
})

export const AcquisitionSchema = z.object({
  id: z.string(), libraryId: z.string(), title: z.string(), author: z.string(),
  state: AcquisitionStateSchema, progressPercent: z.number().min(0).max(100).nullable().optional(),
  absItemId: z.string().nullable().optional(), error: GatewayErrorSchema.nullable().optional(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime()
})

export const CreateAcquisitionBodySchema = z.object({
  searchSessionId: z.string().min(12), releaseId: z.string().min(12), idempotencyKey: z.string().uuid()
})

export type Acquisition = z.infer<typeof AcquisitionSchema>
export type AcquisitionState = z.infer<typeof AcquisitionStateSchema>
```

- [ ] **Step 4: Run contract tests**

```bash
pnpm install
pnpm --filter @abs/acquisition-contract test
```

Expected: PASS with 2 tests.

- [ ] **Step 5: Commit**

```bash
git add pnpm-workspace.yaml package.json pnpm-lock.yaml packages/acquisition-contract
git commit -m "feat: add acquisition workspace contract"
```

### Task 2: Add the typed acquisition client

**Files:**
- Create: `packages/acquisition-client/package.json`
- Create: `packages/acquisition-client/tsconfig.json`
- Create: `packages/acquisition-client/src/index.ts`
- Test: `packages/acquisition-client/src/index.test.ts`

- [ ] **Step 1: Write a failing transport test**

```ts
import { describe, expect, it, vi } from 'vitest'
import { createAcquisitionClient } from './index'

it('sends bearer auth and parses status', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    version: '1.0.0', ready: true, libraries: [{ id: 'lib1', enabled: true }]
  }), { status: 200, headers: { 'content-type': 'application/json' } }))
  const client = createAcquisitionClient({ baseUrl: 'https://books.test/acquisition-api/v1', getAccessToken: async () => 'token', fetcher })
  await expect(client.status()).resolves.toMatchObject({ ready: true })
  expect(fetcher).toHaveBeenCalledWith('https://books.test/acquisition-api/v1/status', expect.objectContaining({
    headers: expect.any(Headers), credentials: 'include'
  }))
  expect((fetcher.mock.calls[0][1].headers as Headers).get('authorization')).toBe('Bearer token')
})
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm --filter @abs/acquisition-client test
```

Expected: FAIL because `createAcquisitionClient` is missing.

- [ ] **Step 3: Implement the client core**

```ts
export class AcquisitionApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message) }
}

export function createAcquisitionClient(options: {
  baseUrl: string
  getAccessToken?: () => Promise<string | null>
  fetcher?: typeof fetch
}) {
  const fetcher = options.fetcher ?? fetch
  const request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const headers = new Headers(init.headers)
    headers.set('accept', 'application/json')
    const token = await options.getAccessToken?.()
    if (token) headers.set('authorization', `Bearer ${token}`)
    const response = await fetcher(`${options.baseUrl}${path}`, { ...init, headers, credentials: 'include' })
    const body = await response.json()
    if (!response.ok) throw new AcquisitionApiError(response.status, body.code ?? 'gateway_error', body.message ?? 'Gateway request failed')
    return body as T
  }
  return { status: () => request<{ version: string; ready: boolean; libraries: { id: string; enabled: boolean }[] }>('/status') }
}
```

- [ ] **Step 4: Run tests and typecheck**

```bash
pnpm --filter @abs/acquisition-client test
pnpm --filter @abs/acquisition-client typecheck
```

Expected: both commands exit `0`.

- [ ] **Step 5: Commit**

```bash
git add packages/acquisition-client pnpm-lock.yaml
git commit -m "feat: add typed acquisition client"
```

### Task 3: Add validated gateway configuration

**Files:**
- Create: `services/acquisition-gateway/package.json`
- Create: `services/acquisition-gateway/tsconfig.json`
- Create: `services/acquisition-gateway/src/config.ts`
- Test: `services/acquisition-gateway/src/config.test.ts`

- [ ] **Step 1: Write failing configuration tests**

```ts
import { expect, it } from 'vitest'
import { loadConfig } from './config'

it('parses library mappings and rejects overlapping roots', () => {
  const base = {
    ABS_INTERNAL_URL: 'http://abs:13378', ABS_SERVICE_TOKEN: 'secret',
    LIBRARR_INTERNAL_URL: 'http://librarr:5050', LIBRARR_API_KEY: 'key',
    GATEWAY_DB_PATH: '/data/gateway.sqlite', STAGING_ROOT: '/media/staging'
  }
  expect(loadConfig({ ...base, LIBRARY_MAPPINGS_JSON: '{"lib1":"/media/library"}' }).libraries.get('lib1')).toBe('/media/library')
  expect(() => loadConfig({ ...base, LIBRARY_MAPPINGS_JSON: '{"lib1":"/media/staging/library"}' })).toThrow('overlap')
})
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm --filter @abs/acquisition-gateway test -- src/config.test.ts
```

Expected: FAIL because `loadConfig` does not exist.

- [ ] **Step 3: Implement strict environment parsing**

```ts
const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  ABS_INTERNAL_URL: z.string().url(), ABS_SERVICE_TOKEN: z.string().min(1),
  LIBRARR_INTERNAL_URL: z.string().url(), LIBRARR_API_KEY: z.string().min(1),
  GATEWAY_DB_PATH: z.string().min(1), STAGING_ROOT: z.string().min(1),
  LIBRARY_MAPPINGS_JSON: z.string().min(2), SEARCH_TTL_SECONDS: z.coerce.number().int().positive().default(900)
})

export function loadConfig(input: NodeJS.ProcessEnv) {
  const env = EnvSchema.parse(input)
  const libraries = new Map(Object.entries(z.record(z.string(), z.string()).parse(JSON.parse(env.LIBRARY_MAPPINGS_JSON))))
  const staging = path.resolve(env.STAGING_ROOT)
  for (const root of libraries.values()) {
    const resolved = path.resolve(root)
    if (resolved === staging || resolved.startsWith(staging + path.sep) || staging.startsWith(resolved + path.sep)) {
      throw new Error(`staging/library roots overlap: ${staging} and ${resolved}`)
    }
  }
  return { ...env, stagingRoot: staging, libraries }
}
```

- [ ] **Step 4: Verify the tests**

```bash
pnpm --filter @abs/acquisition-gateway test -- src/config.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/acquisition-gateway pnpm-lock.yaml
git commit -m "feat: validate acquisition gateway configuration"
```

### Task 4: Create SQLite migrations and repositories

**Files:**
- Create: `services/acquisition-gateway/src/db/migrations/001_initial.sql`
- Create: `services/acquisition-gateway/src/db/database.ts`
- Create: `services/acquisition-gateway/src/db/acquisitionRepository.ts`
- Create: `services/acquisition-gateway/src/db/searchRepository.ts`
- Test: `services/acquisition-gateway/src/db/database.test.ts`

- [ ] **Step 1: Write the failing migration/idempotency test**

```ts
it('enforces one acquisition per user and idempotency key', () => {
  const db = openDatabase(':memory:')
  const repo = new AcquisitionRepository(db)
  repo.create(fixture({ id: 'a1', idempotencyKey: 'same' }))
  expect(() => repo.create(fixture({ id: 'a2', idempotencyKey: 'same' }))).toThrow()
  db.close()
})
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm --filter @abs/acquisition-gateway test -- src/db/database.test.ts
```

Expected: FAIL because the database module is missing.

- [ ] **Step 3: Add the initial migration**

```sql
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE search_sessions (
  id TEXT PRIMARY KEY, abs_user_id TEXT NOT NULL, abs_library_id TEXT NOT NULL,
  query TEXT NOT NULL, results_json TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE acquisitions (
  id TEXT PRIMARY KEY, abs_user_id TEXT NOT NULL, abs_library_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL, search_session_id TEXT NOT NULL, release_id TEXT NOT NULL,
  librarr_job_id TEXT, title TEXT NOT NULL, author TEXT NOT NULL, narrators_json TEXT NOT NULL DEFAULT '[]',
  format TEXT, size_bytes INTEGER, source_label TEXT, state TEXT NOT NULL, progress_percent REAL,
  staging_path TEXT, final_path TEXT, abs_item_id TEXT, error_code TEXT, error_message TEXT,
  error_retryable INTEGER NOT NULL DEFAULT 0, last_successful_stage TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT,
  UNIQUE(abs_user_id, idempotency_key),
  FOREIGN KEY(search_session_id) REFERENCES search_sessions(id)
);
CREATE INDEX acquisitions_user_library_updated ON acquisitions(abs_user_id, abs_library_id, updated_at DESC);
```

Implement `openDatabase()` to enable `foreign_keys`, `journal_mode=WAL`, and `busy_timeout=5000`, apply embedded migrations in one transaction, and expose repositories with prepared statements.

- [ ] **Step 4: Verify persistence and restart behavior**

```bash
pnpm --filter @abs/acquisition-gateway test -- src/db/database.test.ts
```

Expected: PASS for migration, uniqueness, round trip, and reopen tests.

- [ ] **Step 5: Commit**

```bash
git add services/acquisition-gateway/src/db
git commit -m "feat: persist gateway acquisition state"
```

### Task 5: Authenticate against Audiobookshelf and expose status

**Files:**
- Create: `services/acquisition-gateway/src/auth/absAuth.ts`
- Create: `services/acquisition-gateway/src/routes/status.ts`
- Create: `services/acquisition-gateway/src/app.ts`
- Create: `services/acquisition-gateway/src/main.ts`
- Test: `services/acquisition-gateway/src/auth/absAuth.test.ts`
- Test: `services/acquisition-gateway/src/routes/status.test.ts`

- [ ] **Step 1: Write failing auth tests**

```ts
it('accepts bearer before access_token cookie and fails closed on ABS denial', async () => {
  const validate = vi.fn().mockResolvedValue({ id: 'u1', librariesAccessible: ['lib1'], isActive: true })
  const auth = createAbsAuth({ validate })
  await expect(auth({ headers: { authorization: 'Bearer mobile-token', cookie: 'access_token=web-token' } })).resolves.toMatchObject({ id: 'u1' })
  expect(validate).toHaveBeenCalledWith('mobile-token')
  validate.mockRejectedValueOnce(new Error('401'))
  await expect(auth({ headers: { cookie: 'access_token=bad' } })).rejects.toMatchObject({ statusCode: 401 })
})
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm --filter @abs/acquisition-gateway test -- src/auth/absAuth.test.ts src/routes/status.test.ts
```

Expected: FAIL because auth and status routes are missing.

- [ ] **Step 3: Implement token extraction and validation**

```ts
export function extractAccessToken(headers: { authorization?: string; cookie?: string }): string | null {
  const bearer = headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]
  if (bearer) return bearer
  return parseCookie(headers.cookie ?? '').access_token ?? null
}

export async function validateAbsUser(token: string, absUrl: string, fetcher: typeof fetch) {
  const response = await fetcher(`${absUrl}/api/me`, { headers: { authorization: `Bearer ${token}` } })
  if (!response.ok) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
  const user = await response.json()
  if (!user?.id || user.isActive === false) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
  return user
}
```

Register an `onRequest` hook for `/acquisition-api/v1/*`, decorate the request with the validated user, and return:

```ts
{
  version: '1.0.0',
  ready: librarrOk && stagingOk,
  librarr: { reachable: librarrOk },
  staging: { ready: stagingOk },
  libraries: [...config.libraries.keys()]
    .filter(id => user.permissions?.accessAllLibraries === true || user.librariesAccessible?.includes(id))
    .map(id => ({ id, enabled: true }))
}
```

- [ ] **Step 4: Run gateway verification**

```bash
pnpm --filter @abs/acquisition-gateway test
pnpm --filter @abs/acquisition-gateway typecheck
```

Expected: all tests pass and typecheck exits `0`.

- [ ] **Step 5: Commit**

```bash
git add services/acquisition-gateway/src/auth services/acquisition-gateway/src/routes services/acquisition-gateway/src/app.ts services/acquisition-gateway/src/main.ts
git commit -m "feat: authenticate gateway through audiobookshelf"
```

### Task 6: Containerize and add CI coverage

**Files:**
- Create: `services/acquisition-gateway/Dockerfile`
- Create: `services/acquisition-gateway/.dockerignore`
- Create: `deploy/acquisition/docker-compose.example.yml`
- Modify: `.github/workflows/ci.yml`
- Create: `.github/workflows/acquisition-gateway-image.yml`

- [ ] **Step 1: Add a container smoke command**

```dockerfile
FROM node:22-alpine AS build
RUN corepack enable pnpm
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages ./packages
COPY services/acquisition-gateway ./services/acquisition-gateway
RUN pnpm --filter @abs/acquisition-gateway... install --frozen-lockfile && pnpm --filter @abs/acquisition-gateway build

FROM node:22-alpine
WORKDIR /app
COPY --from=build /repo/services/acquisition-gateway/dist ./dist
COPY --from=build /repo/services/acquisition-gateway/node_modules ./node_modules
COPY --from=build /repo/services/acquisition-gateway/package.json ./package.json
USER node
CMD ["node", "dist/main.js"]
```

- [ ] **Step 2: Configure the example deployment**

```yaml
services:
  acquisition-gateway:
    image: ghcr.io/scott-hf/audiobookshelf-acquisition-gateway:latest
    environment:
      ABS_INTERNAL_URL: http://audiobookshelf:13378
      LIBRARR_INTERNAL_URL: http://librarr:5050
      GATEWAY_DB_PATH: /data/gateway.sqlite
      STAGING_ROOT: /media/staging
      LIBRARY_MAPPINGS_JSON: '{"replace-with-abs-library-id":"/media/audiobooks"}'
    volumes:
      - gateway-data:/data
      - audiobook-media:/media
```

- [ ] **Step 3: Add CI commands**

```yaml
- name: Workspace tests
  run: pnpm test:workspace
- name: Workspace typecheck
  run: pnpm typecheck:workspace
```

- [ ] **Step 4: Build and smoke-test the image**

```bash
docker build -f services/acquisition-gateway/Dockerfile -t acquisition-gateway:test .
docker run --rm acquisition-gateway:test node dist/main.js --help
```

Expected: image builds; the entry point starts argument parsing without a missing-module error.

- [ ] **Step 5: Commit**

```bash
git add services/acquisition-gateway/Dockerfile services/acquisition-gateway/.dockerignore deploy/acquisition .github/workflows package.json pnpm-lock.yaml
git commit -m "ci: build acquisition gateway container"
```
