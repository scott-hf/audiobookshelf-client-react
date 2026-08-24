import Fastify, { type FastifyInstance } from 'fastify'
import type { GatewayConfig } from './config'
import { createAbsAuth, validateAbsUser, type AbsUser } from './auth/absAuth'
import { registerStatusRoute } from './routes/status'
import { registerSearchRoute } from './routes/search'
import { registerAcquisitionsRoutes } from './routes/acquisitions'
import { registerEventsRoute } from './routes/events'
import { openDatabase } from './db/database'
import { SearchRepository } from './db/searchRepository'
import { AcquisitionRepository } from './db/acquisitionRepository'
import { LibrarrClient } from './adapters/librarrClient'
import { SearchService } from './services/searchService'
import { AcquisitionService } from './services/acquisitionService'
import { Reconciler } from './services/reconciler'
import { EventBus } from './events/eventBus'

declare module 'fastify' {
  interface FastifyRequest {
    absUser?: AbsUser
  }
}

export interface BuildAppOptions {
  config: GatewayConfig
  /** Used for ABS auth calls and, unless librarrFetcher is given, Librarr calls too. */
  fetcher?: typeof fetch
  /** Separate injectable fetcher for the LibrarrClient -- lets tests stub Librarr responses
   * independently of the ABS auth fetcher. Defaults to `fetcher`. */
  librarrFetcher?: typeof fetch
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

  const db = openDatabase(options.config.GATEWAY_DB_PATH)
  const searchRepo = new SearchRepository(db)
  const acquisitionRepo = new AcquisitionRepository(db)
  const librarr = new LibrarrClient({
    baseUrl: options.config.LIBRARR_INTERNAL_URL,
    apiKey: options.config.LIBRARR_API_KEY,
    fetcher: options.librarrFetcher ?? fetcher
  })
  const searchService = new SearchService({
    librarr,
    repo: searchRepo,
    ttlSeconds: options.config.SEARCH_TTL_SECONDS
  })
  const acquisitionService = new AcquisitionService({ librarr, repo: acquisitionRepo, searchService })
  const eventBus = new EventBus()

  let ready = false
  const reconciler = new Reconciler({
    librarr,
    repo: acquisitionRepo,
    searchRepo,
    intervalMs: options.config.RECONCILE_INTERVAL_MS,
    stallTimeoutSeconds: options.config.STALL_TIMEOUT_SECONDS,
    historyRetentionSeconds: options.config.HISTORY_RETENTION_SECONDS,
    onEvent: (acquisitionId) => {
      const record = acquisitionRepo.findById(acquisitionId)
      if (record) eventBus.publish(record.absUserId, { type: 'acquisition.updated', acquisitionId })
    }
  })

  // Startup catch-up: reconcile every non-terminal acquisition against Librarr's live queue
  // BEFORE mutation routes are enabled (registerAcquisitionsRoutes checks isReady()), so a
  // restart can never race a fresh mutation against stale in-memory state. Errors are
  // logged, not fatal -- a Librarr outage at boot should not crash the gateway.
  app.addHook('onReady', async () => {
    try {
      await reconciler.runOnce()
    } catch (error) {
      app.log.error({ err: error }, 'initial acquisition reconciliation failed')
    }
    ready = true
    reconciler.start()
  })

  app.addHook('onClose', async () => {
    reconciler.stop()
    db.close()
  })

  registerStatusRoute(app, options.config, fetcher)
  registerSearchRoute(app, searchService)
  registerAcquisitionsRoutes(app, acquisitionService, eventBus, () => ready)
  registerEventsRoute(app, eventBus)

  return app
}
