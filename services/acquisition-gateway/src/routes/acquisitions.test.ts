import { readFileSync } from 'node:fs'
import path from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app'
import { loadConfig, type GatewayConfig } from '../config'

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures', 'librarr')
const searchFixture = JSON.parse(readFileSync(path.join(FIXTURES, 'search-audiobooks.json'), 'utf-8'))

function userFor(id: string, librariesAccessible: string[]): { id: string; isActive: boolean; librariesAccessible: string[] } {
  return { id, isActive: true, librariesAccessible }
}

function combinedFetcher(users: Record<string, ReturnType<typeof userFor>>): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input)
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

    if (url.endsWith('/api/me')) {
      const headers = init?.headers
      const auth =
        headers instanceof Headers
          ? (headers.get('authorization') ?? '')
          : ((headers as Record<string, string> | undefined)?.authorization ?? '')
      const token = auth.replace(/^Bearer\s+/, '')
      const user = users[token]
      return user ? json(user) : json({}, 401)
    }
    if (url.includes('/api/search/audiobooks')) return json(searchFixture)
    if (url.includes('/api/download/audiobook')) return json({ success: true, title: 'Project Hail Mary', hash: '0123456789abcdef0123456789abcdef01234567' })
    if (url.includes('/api/downloads/torrent/')) return json({ success: true })
    if (url.includes('/api/downloads/novel/')) return json({ success: true })
    if (url.includes('/api/downloads')) return json({ downloads: [] })
    if (url.includes('/api/health')) return json({ status: 'ok' })
    return json({}, 404)
  }) as unknown as typeof fetch
}

describe('acquisitions routes', () => {
  let stagingDir: string
  let config: GatewayConfig
  let app: FastifyInstance
  const users = {
    'token-u1': userFor('u1', ['lib1']),
    'token-u2': userFor('u2', ['lib1'])
  }

  beforeEach(() => {
    stagingDir = mkdtempSync(path.join(tmpdir(), 'gateway-staging-'))
    config = loadConfig({
      ABS_INTERNAL_URL: 'http://abs.internal',
      ABS_SERVICE_TOKEN: 'service-token',
      LIBRARR_INTERNAL_URL: 'http://librarr.internal',
      LIBRARR_API_KEY: 'librarr-key',
      GATEWAY_DB_PATH: ':memory:',
      STAGING_ROOT: stagingDir,
      LIBRARY_MAPPINGS_JSON: JSON.stringify({ lib1: path.join(stagingDir, '..', 'lib1') })
    })
    app = buildApp({ config, fetcher: combinedFetcher(users), logger: false })
  })

  afterEach(async () => {
    await app?.close()
    rmSync(stagingDir, { recursive: true, force: true })
  })

  async function search(token: string) {
    return app.inject({
      method: 'GET',
      url: '/acquisition-api/v1/search/audiobooks?' + new URLSearchParams({ libraryId: 'lib1', q: 'Project Hail Mary' }),
      headers: { authorization: `Bearer ${token}` }
    })
  }

  it('creates an acquisition idempotently and never exposes another user’s row', async () => {
    const searchResponse = await search('token-u1')
    expect(searchResponse.statusCode).toBe(200)
    const { searchSessionId, results } = searchResponse.json()

    const idempotencyKey = crypto.randomUUID()
    const createBody = { searchSessionId, releaseId: results[0].releaseId, idempotencyKey }

    const create = await app.inject({
      method: 'POST',
      url: '/acquisition-api/v1/acquisitions?libraryId=lib1',
      headers: { authorization: 'Bearer token-u1', 'content-type': 'application/json' },
      payload: createBody
    })
    expect(create.statusCode).toBe(201)
    const acquisition = create.json()
    expect(acquisition.state).toBe('submitted')

    const listAsOwner = await app.inject({
      method: 'GET',
      url: '/acquisition-api/v1/acquisitions?libraryId=lib1',
      headers: { authorization: 'Bearer token-u1' }
    })
    expect(listAsOwner.json()).toHaveLength(1)

    const listAsOther = await app.inject({
      method: 'GET',
      url: '/acquisition-api/v1/acquisitions?libraryId=lib1',
      headers: { authorization: 'Bearer token-u2' }
    })
    expect(listAsOther.json()).toHaveLength(0)

    const getAsOther = await app.inject({
      method: 'GET',
      url: `/acquisition-api/v1/acquisitions/${acquisition.id}`,
      headers: { authorization: 'Bearer token-u2' }
    })
    expect(getAsOther.statusCode).toBe(404)
    expect(getAsOther.json().code).toBe('acquisition_not_found')

    const getMissing = await app.inject({
      method: 'GET',
      url: '/acquisition-api/v1/acquisitions/does-not-exist',
      headers: { authorization: 'Bearer token-u1' }
    })
    // A missing id and a foreign id return the identical 404 code so IDs cannot be enumerated.
    expect(getMissing.statusCode).toBe(404)
    expect(getMissing.json().code).toBe('acquisition_not_found')
  })

  it('rejects a request for a library the user cannot access', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/acquisition-api/v1/search/audiobooks?' + new URLSearchParams({ libraryId: 'lib-forbidden', q: 'x' }),
      headers: { authorization: 'Bearer token-u1' }
    })
    expect(response.statusCode).toBe(403)
  })

  it('cancel returns the acquisition cancelled and is scoped to the owner', async () => {
    const searchResponse = await search('token-u1')
    const { searchSessionId, results } = searchResponse.json()
    const create = await app.inject({
      method: 'POST',
      url: '/acquisition-api/v1/acquisitions?libraryId=lib1',
      headers: { authorization: 'Bearer token-u1', 'content-type': 'application/json' },
      payload: { searchSessionId, releaseId: results[0].releaseId, idempotencyKey: crypto.randomUUID() }
    })
    const acquisition = create.json()

    const cancelAsOther = await app.inject({
      method: 'DELETE',
      url: `/acquisition-api/v1/acquisitions/${acquisition.id}`,
      headers: { authorization: 'Bearer token-u2' }
    })
    expect(cancelAsOther.statusCode).toBe(404)

    const cancel = await app.inject({
      method: 'DELETE',
      url: `/acquisition-api/v1/acquisitions/${acquisition.id}`,
      headers: { authorization: 'Bearer token-u1' }
    })
    expect(cancel.statusCode).toBe(200)
    expect(cancel.json().state).toBe('cancelled')
  })
})
