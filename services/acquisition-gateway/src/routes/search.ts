import type { FastifyInstance } from 'fastify'
import { SearchQuerySchema } from '@abs/acquisition-contract'
import type { AbsUser } from '../auth/absAuth'
import type { SearchService } from '../services/searchService'

export function registerSearchRoute(app: FastifyInstance, searchService: SearchService): void {
  app.register(
    async (instance) => {
      instance.get('/search/audiobooks', async (request, reply) => {
        const user = request.absUser as AbsUser
        const parsed = SearchQuerySchema.safeParse(request.query)
        if (!parsed.success) {
          return reply.code(400).send({
            code: 'invalid_query',
            message: 'libraryId and q are required',
            retryable: false,
            lastSuccessfulStage: null
          })
        }
        const { libraryId, q } = parsed.data
        if (user.permissions?.accessAllLibraries !== true && !user.librariesAccessible?.includes(libraryId)) {
          return reply.code(403).send({
            code: 'library_forbidden',
            message: 'You do not have access to this library',
            retryable: false,
            lastSuccessfulStage: null
          })
        }
        const response = await searchService.search(user.id, libraryId, q)
        return reply.code(200).send(response)
      })
    },
    { prefix: '/acquisition-api/v1' }
  )
}
