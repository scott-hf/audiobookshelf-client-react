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
import { AbsAdminClient } from './adapters/absAdminClient'
import { SearchService } from './services/searchService'
import { AcquisitionService } from './services/acquisitionService'
import { Reconciler } from './services/reconciler'
import { ImportCoordinator } from './services/importCoordinator'
import { StagingInspector } from './services/stagingInspector'
import { FileHandoff, nodeFsAdapter } from './services/fileHandoff'
import { EventBus } from './events/eventBus'

declare module 'fastify' {
  interface FastifyRequest {
    absUser?: AbsUser
  }
  interface FastifyInstance {
    /** Internal seam for tests and operational tooling: lets a caller drive one reconcile
     * pass deterministically instead of waiting on the interval timer. Not an HTTP route --
     * it adds no public surface. */
    acquisitionInternals: { reconcileOnce: () => Promise<void> }
  }
}

export interface BuildAppOptions {
  config: GatewayConfig
  /** Used for ABS auth calls and, unless librarrFetcher is given, Librarr calls too. */
  fetcher?: typeof fetch
  /** Separate injectable fetcher for the LibrarrClient -- lets tests stub Librarr responses
   * independently of the ABS auth fetcher. Defaults to `fetcher`. */
  librarrFetcher?: typeof fetch
  /** Separate injectable fetcher for the privileged ABS admin client (scan/items). Defaults
   * to `fetcher`; the e2e harness points it at a fake ABS. */
  absAdminFetcher?: typeof fetch
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
  const eventBus = new EventBus()

  // Import handoff (Plan 3 / Gate 3): processing -> staged -> importing -> scanning ->
  // available. Correlation and cleanup policy are pinned in docs/handoff/correlation-note.md.
  const absAdmin = new AbsAdminClient({
    baseUrl: options.config.ABS_INTERNAL_URL,
    serviceToken: options.config.ABS_SERVICE_TOKEN,
    fetcher: options.absAdminFetcher ?? fetcher
  })
  const fsAdapter = nodeFsAdapter()
  const importCoordinator = new ImportCoordinator({
    repo: acquisitionRepo,
    librarr,
    abs: absAdmin,
    inspector: new StagingInspector({
      stagingRoot: options.config.stagingRoot,
      stabilitySeconds: options.config.STAGING_STABILITY_SECONDS
    }),
    handoff: new FileHandoff(fsAdapter),
    fs: fsAdapter,
    libraries: options.config.libraries,
    stallTimeoutSeconds: options.config.STALL_TIMEOUT_SECONDS,
    cleanupEnabled: options.config.IMPORT_CLEANUP_ENABLED,
    finalTreeMode: options.config.FINAL_TREE_MODE,
    finalTreeFileMode: parseInt(options.config.FINAL_TREE_FILE_MODE, 8),
    finalTreeDirMode: parseInt(options.config.FINAL_TREE_DIR_MODE, 8),
    onEvent: (acquisitionId) => {
      const record = acquisitionRepo.findById(acquisitionId)
      if (record) eventBus.publish(record.absUserId, { type: 'acquisition.updated', acquisitionId })
    },
    log: { warn: (obj, msg) => app.log.warn(obj as object, msg) }
  })

  const acquisitionService = new AcquisitionService({
    librarr,
    repo: acquisitionRepo,
    searchService,
    importCoordinator
  })

  let ready = false
  const reconciler = new Reconciler({
    librarr,
    repo: acquisitionRepo,
    searchRepo,
    importCoordinator,
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

  app.decorate('acquisitionInternals', { reconcileOnce: () => reconciler.runOnce() })

  registerStatusRoute(app, options.config, fetcher)
  registerSearchRoute(app, searchService)
  registerAcquisitionsRoutes(app, acquisitionService, eventBus, () => ready)
  registerEventsRoute(app, eventBus)

  return app
}
