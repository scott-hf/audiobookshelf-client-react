import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from './app'
import { loadConfig, type GatewayConfig } from './config'

/**
 * The gateway is only ever called cross-origin by the mobile client (a Capacitor WebView, or a
 * local dev server), so without CORS the preflight fails and no route is ever reached -- the
 * failure mode is invisible server-side, which is why it went unnoticed.
 */
describe('CORS', () => {
  let stagingDir: string
  let app: FastifyInstance

  const buildConfig = (overrides: Record<string, string> = {}): GatewayConfig =>
    loadConfig({
      ABS_INTERNAL_URL: 'http://abs.internal',
      ABS_SERVICE_TOKEN: 'service-token',
      LIBRARR_INTERNAL_URL: 'http://librarr.internal',
      LIBRARR_API_KEY: 'librarr-key',
      GATEWAY_DB_PATH: ':memory:',
      STAGING_ROOT: stagingDir,
      LIBRARY_MAPPINGS_JSON: JSON.stringify({ lib1: path.join(stagingDir, '..', 'lib1') }),
      ...overrides
    })

  const preflight = (origin: string) =>
    app.inject({
      method: 'OPTIONS',
      url: '/acquisition-api/v1/status',
      headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' }
    })

  beforeEach(() => {
    stagingDir = mkdtempSync(path.join(tmpdir(), 'gateway-staging-'))
  })

  afterEach(async () => {
    await app.close()
    rmSync(stagingDir, { recursive: true, force: true })
  })

  it('allows the Capacitor WebView origins by default', async () => {
    app = buildApp({ config: buildConfig(), logger: false })
    await app.ready()

    for (const origin of ['capacitor://localhost', 'https://localhost', 'http://localhost']) {
      const response = await preflight(origin)
      expect(response.statusCode, origin).toBeLessThan(300)
      expect(response.headers['access-control-allow-origin'], origin).toBe(origin)
    }
  })

  it('answers a preflight without authentication', async () => {
    // The auth hook must not run for OPTIONS: a preflight carries no Authorization header, so
    // authenticating it would 401 every cross-origin request before the real one is sent.
    app = buildApp({ config: buildConfig(), logger: false })
    await app.ready()

    const response = await preflight('capacitor://localhost')

    expect(response.statusCode).not.toBe(401)
    expect(response.headers['access-control-allow-methods']).toContain('POST')
    expect(response.headers['access-control-allow-headers']).toContain('authorization')
  })

  it('does not echo an origin that is not allowlisted', async () => {
    app = buildApp({ config: buildConfig(), logger: false })
    await app.ready()

    const response = await preflight('https://evil.example')

    expect(response.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('honours an explicit ALLOWED_ORIGINS override', async () => {
    app = buildApp({ config: buildConfig({ ALLOWED_ORIGINS: 'https://books.example' }), logger: false })
    await app.ready()

    expect((await preflight('https://books.example')).headers['access-control-allow-origin']).toBe('https://books.example')
    // Overriding replaces the defaults rather than extending them.
    expect((await preflight('capacitor://localhost')).headers['access-control-allow-origin']).toBeUndefined()
  })

  it('rejects every browser origin when ALLOWED_ORIGINS is empty', async () => {
    app = buildApp({ config: buildConfig({ ALLOWED_ORIGINS: '' }), logger: false })
    await app.ready()

    expect((await preflight('capacitor://localhost')).headers['access-control-allow-origin']).toBeUndefined()
  })

  it('never sets Allow-Credentials -- the client is bearer-token only', async () => {
    app = buildApp({ config: buildConfig(), logger: false })
    await app.ready()

    const response = await preflight('capacitor://localhost')

    expect(response.headers['access-control-allow-credentials']).toBeUndefined()
  })

  it('still requires auth on the real request, not just the preflight', async () => {
    app = buildApp({ config: buildConfig(), logger: false })
    await app.ready()

    const response = await app.inject({
      method: 'GET',
      url: '/acquisition-api/v1/status',
      headers: { origin: 'capacitor://localhost' }
    })

    expect(response.statusCode).toBe(401)
  })
})
