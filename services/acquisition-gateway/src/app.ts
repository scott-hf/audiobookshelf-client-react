import Fastify, { type FastifyInstance } from 'fastify'
import type { GatewayConfig } from './config'
import { createAbsAuth, validateAbsUser, type AbsUser } from './auth/absAuth'
import { registerStatusRoute } from './routes/status'

declare module 'fastify' {
  interface FastifyRequest {
    absUser?: AbsUser
  }
}

export interface BuildAppOptions {
  config: GatewayConfig
  fetcher?: typeof fetch
  logger?: boolean
}

const AUTHENTICATED_PREFIX = '/acquisition-api/v1/'

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const fetcher = options.fetcher ?? fetch
  const app = Fastify({ logger: options.logger ?? true })

  const auth = createAbsAuth({
    validate: (token) => validateAbsUser(token, options.config.ABS_INTERNAL_URL, fetcher)
  })

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith(AUTHENTICATED_PREFIX)) return
    try {
      request.absUser = await auth({
        headers: { authorization: request.headers.authorization, cookie: request.headers.cookie }
      })
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 401
      await reply.code(statusCode).send({
        code: 'unauthorized',
        message: 'Unauthorized',
        retryable: false,
        lastSuccessfulStage: null
      })
    }
  })

  registerStatusRoute(app, options.config, fetcher)

  return app
}
