import type { FastifyInstance, FastifyReply } from 'fastify'
import { CreateAcquisitionBodySchema } from '@abs/acquisition-contract'
import type { AbsUser } from '../auth/absAuth'
import type { AcquisitionService } from '../services/acquisitionService'
import { DomainError } from '../domain/errors'
import type { EventBus } from '../events/eventBus'

const DOMAIN_ERROR_STATUS: Record<string, number> = {
  search_not_found: 404,
  search_expired: 410,
  release_not_found: 404,
  release_not_trackable: 409,
  library_mismatch: 403,
  acquisition_not_found: 404,
  acquisition_not_retryable: 409,
  acquisition_not_cancellable: 409
}

function sendDomainError(reply: FastifyReply, error: DomainError): FastifyReply {
  const status = DOMAIN_ERROR_STATUS[error.code] ?? 400
  return reply.code(status).send({
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    lastSuccessfulStage: null
  })
}

export function registerAcquisitionsRoutes(
  app: FastifyInstance,
  service: AcquisitionService,
  eventBus?: EventBus,
  isReady: () => boolean = () => true
): void {
  const requireReady = (reply: FastifyReply): boolean => {
    if (isReady()) return true
    reply.code(503).send({
      code: 'gateway_not_ready',
      message: 'Startup reconciliation is still in progress',
      retryable: true,
      lastSuccessfulStage: null
    })
    return false
  }

  app.register(
    async (instance) => {
      instance.post('/acquisitions', async (request, reply) => {
        if (!requireReady(reply)) return
        const user = request.absUser as AbsUser
        const libraryId = (request.query as { libraryId?: string }).libraryId
        if (!libraryId) {
          return reply.code(400).send({ code: 'invalid_query', message: 'libraryId is required', retryable: false, lastSuccessfulStage: null })
        }
        if (user.permissions?.accessAllLibraries !== true && !user.librariesAccessible?.includes(libraryId)) {
          return reply.code(403).send({ code: 'library_forbidden', message: 'You do not have access to this library', retryable: false, lastSuccessfulStage: null })
        }
        const parsed = CreateAcquisitionBodySchema.safeParse(request.body)
        if (!parsed.success) {
          return reply.code(400).send({ code: 'invalid_body', message: 'Invalid acquisition request body', retryable: false, lastSuccessfulStage: null })
        }
        try {
          const acquisition = await service.create(user, libraryId, parsed.data)
          eventBus?.publish(user.id, { type: 'acquisition.created', acquisitionId: acquisition.id })
          return reply.code(201).send(acquisition)
        } catch (error) {
          if (error instanceof DomainError) return sendDomainError(reply, error)
          throw error
        }
      })

      instance.get('/acquisitions', async (request, reply) => {
        const user = request.absUser as AbsUser
        const libraryId = (request.query as { libraryId?: string }).libraryId
        if (!libraryId) {
          return reply.code(400).send({ code: 'invalid_query', message: 'libraryId is required', retryable: false, lastSuccessfulStage: null })
        }
        return reply.code(200).send(service.list(user, libraryId))
      })

      instance.get('/acquisitions/:acquisitionId', async (request, reply) => {
        const user = request.absUser as AbsUser
        const { acquisitionId } = request.params as { acquisitionId: string }
        try {
          return reply.code(200).send(service.get(user, acquisitionId))
        } catch (error) {
          if (error instanceof DomainError) return sendDomainError(reply, error)
          throw error
        }
      })

      instance.post('/acquisitions/:acquisitionId/retry', async (request, reply) => {
        if (!requireReady(reply)) return
        const user = request.absUser as AbsUser
        const { acquisitionId } = request.params as { acquisitionId: string }
        try {
          const acquisition = await service.retry(user, acquisitionId)
          eventBus?.publish(user.id, { type: 'acquisition.updated', acquisitionId: acquisition.id })
          return reply.code(200).send(acquisition)
        } catch (error) {
          if (error instanceof DomainError) return sendDomainError(reply, error)
          throw error
        }
      })

      instance.delete('/acquisitions/:acquisitionId', async (request, reply) => {
        if (!requireReady(reply)) return
        const user = request.absUser as AbsUser
        const { acquisitionId } = request.params as { acquisitionId: string }
        try {
          const acquisition = await service.cancel(user, acquisitionId)
          eventBus?.publish(user.id, { type: 'acquisition.updated', acquisitionId: acquisition.id })
          return reply.code(200).send(acquisition)
        } catch (error) {
          if (error instanceof DomainError) return sendDomainError(reply, error)
          throw error
        }
      })
    },
    { prefix: '/acquisition-api/v1' }
  )
}
