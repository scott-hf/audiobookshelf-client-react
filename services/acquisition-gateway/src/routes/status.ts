import type { FastifyInstance } from 'fastify'
import { accessSync, constants } from 'node:fs'
import type { GatewayConfig } from '../config'
import type { AbsUser } from '../auth/absAuth'

export interface StatusResponse {
  version: '1.0.0'
  ready: boolean
  librarr: { reachable: boolean }
  staging: { ready: boolean }
  libraries: { id: string; enabled: boolean }[]
}

/**
 * Real Librarr liveness probe: GET /api/health (work/librarr @ 1b86eb1,
 * internal/api/health.go:29-63), which returns {"status":"ok",...} with an x-api-key auth
 * header like every other Librarr route (internal/api/middleware.go:108-113). Replaces the
 * earlier "any response < 500" placeholder (WI-1496 t200 HANDOFF follow-up).
 */
export async function checkLibrarrReachable(librarrUrl: string, apiKey: string, fetcher: typeof fetch): Promise<boolean> {
  try {
    const response = await fetcher(`${librarrUrl.replace(/\/$/, '')}/api/health`, {
      headers: { 'x-api-key': apiKey },
      signal: AbortSignal.timeout(2000)
    })
    if (!response.ok) return false
    const body = (await response.json()) as { status?: string }
    return body.status === 'ok'
  } catch {
    return false
  }
}

export function checkStagingReady(stagingRoot: string): boolean {
  try {
    accessSync(stagingRoot, constants.R_OK | constants.W_OK)
    return true
  } catch {
    return false
  }
}

export function registerStatusRoute(app: FastifyInstance, config: GatewayConfig, fetcher: typeof fetch): void {
  app.register(
    async (instance) => {
      instance.get('/status', async (request): Promise<StatusResponse> => {
        const user = request.absUser as AbsUser
        const [librarrOk, stagingOk] = await Promise.all([
          checkLibrarrReachable(config.LIBRARR_INTERNAL_URL, config.LIBRARR_API_KEY, fetcher),
          Promise.resolve(checkStagingReady(config.stagingRoot))
        ])
        return {
          version: '1.0.0',
          ready: librarrOk && stagingOk,
          librarr: { reachable: librarrOk },
          staging: { ready: stagingOk },
          libraries: [...config.libraries.keys()]
            .filter((id) => user.permissions?.accessAllLibraries === true || user.librariesAccessible?.includes(id))
            .map((id) => ({ id, enabled: true }))
        }
      })
    },
    { prefix: '/acquisition-api/v1' }
  )
}
