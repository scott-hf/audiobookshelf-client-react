import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from './app'
import { loadConfig, type GatewayConfig } from './config'

describe('GET /healthz', () => {
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
      LIBRARY_MAPPINGS_JSON: JSON.stringify({ lib1: path.join(stagingDir, '..', 'lib1') })
    })
  })

  afterEach(async () => {
    await app.close()
    rmSync(stagingDir, { recursive: true, force: true })
  })

  it('returns {ok:true} with no auth required', async () => {
    app = buildApp({ config, logger: false })
    const response = await app.inject({ method: 'GET', url: '/healthz' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: true })
  })

  it('does not require an Authorization header, unlike /acquisition-api/v1/*', async () => {
    app = buildApp({ config, logger: false })
    const response = await app.inject({ method: 'GET', url: '/healthz', headers: {} })
    expect(response.statusCode).toBe(200)
  })
})
