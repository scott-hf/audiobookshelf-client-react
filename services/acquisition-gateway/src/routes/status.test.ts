import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app'
import { loadConfig, type GatewayConfig } from '../config'

function fakeFetcher(user: { id: string; isActive: boolean; librariesAccessible?: string[] }): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input)
    if (url.endsWith('/api/me')) {
      return new Response(JSON.stringify(user), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    // Librarr reachability probe (GET /api/health).
    if (url.endsWith('/api/health')) {
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(null, { status: 200 })
  }) as typeof fetch
}

describe('GET /acquisition-api/v1/status', () => {
  let stagingDir: string
  let config: GatewayConfig
  let app: FastifyInstance

  beforeEach(() => {
    stagingDir = mkdtempSync(path.join(tmpdir(), 'gateway-staging-'))
    config = loadConfig({
      ABS_INTERNAL_URL: 'http://abs.internal',
      ABS_SERVICE_TOKEN: 'service-token',
      LIBRARR_INTERNAL_URL: 'http://librarr.internal',
      LIBRARR_API_KEY: 'librarr-key',
      GATEWAY_DB_PATH: ':memory:',
      STAGING_ROOT: stagingDir,
      LIBRARY_MAPPINGS_JSON: JSON.stringify({ lib1: path.join(stagingDir, '..', 'lib1'), lib2: path.join(stagingDir, '..', 'lib2') })
    })
  })

  afterEach(async () => {
    await app?.close()
    rmSync(stagingDir, { recursive: true, force: true })
  })

  it('rejects an unauthenticated request', async () => {
    app = buildApp({ config, fetcher: fakeFetcher({ id: 'u1', isActive: true }), logger: false })
    const response = await app.inject({ method: 'GET', url: '/acquisition-api/v1/status' })
    expect(response.statusCode).toBe(401)
  })

  it('returns only libraries the authenticated user can access', async () => {
    app = buildApp({
      config,
      fetcher: fakeFetcher({ id: 'u1', isActive: true, librariesAccessible: ['lib1'] }),
      logger: false
    })
    const response = await app.inject({
      method: 'GET',
      url: '/acquisition-api/v1/status',
      headers: { authorization: 'Bearer token' }
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body).toMatchObject({
      version: '1.0.0',
      ready: true,
      librarr: { reachable: true },
      staging: { ready: true },
      libraries: [{ id: 'lib1', enabled: true }]
    })
  })

  it('returns all libraries for an accessAllLibraries admin user', async () => {
    app = buildApp({
      config,
      fetcher: fakeFetcher({ id: 'admin', isActive: true }),
      logger: false
    })
    // Override validateAbsUser response to include permissions -- rebuild with a fetcher
    // that returns accessAllLibraries: true.
    await app.close()
    app = buildApp({
      config,
      fetcher: (async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input)
        if (url.endsWith('/api/me')) {
          return new Response(JSON.stringify({ id: 'admin', isActive: true, permissions: { accessAllLibraries: true } }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
        }
        if (url.endsWith('/api/health')) {
          return new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return new Response(null, { status: 200 })
      }) as typeof fetch,
      logger: false
    })
    const response = await app.inject({
      method: 'GET',
      url: '/acquisition-api/v1/status',
      headers: { authorization: 'Bearer token' }
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.libraries.map((l: { id: string }) => l.id).sort()).toEqual(['lib1', 'lib2'])
  })
})
