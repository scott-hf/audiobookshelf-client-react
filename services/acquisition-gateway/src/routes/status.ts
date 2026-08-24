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
 * Best-effort Librarr liveness probe. The exact health route is confirmed against
 * live Librarr source in the "Librarr acquisition flow" plan; here any response that
 * completes (even a 404) counts as "reachable" since the goal is distinguishing a
 * running service from a network failure/timeout, not validating a specific route.
 */
export async function checkLibrarrReachable(librarrUrl: string, fetcher: typeof fetch): Promise<boolean> {
  try {
    const response = await fetcher(librarrUrl, { signal: AbortSignal.timeout(2000) })
    return response.status < 500
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
          checkLibrarrReachable(config.LIBRARR_INTERNAL_URL, fetcher),
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
