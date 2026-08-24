import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { AcquisitionEvent } from '@abs/acquisition-contract'
import type { AbsUser } from '../auth/absAuth'
import type { EventBus } from '../events/eventBus'

function writeSseEvent(res: NodeJS.WritableStream, event: AcquisitionEvent): void {
  res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
}

/** Exported separately from route registration so it can be unit-tested against fake
 * request/reply doubles without opening a real long-lived HTTP connection (an SSE stream
 * never completes on its own, which would hang Fastify's `.inject()`). */
export function createEventsHandler(eventBus: EventBus) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const user = request.absUser as AbsUser
    reply.hijack()
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    })

    const lastEventId = (request.headers['last-event-id'] as string | undefined) ?? '0'
    for (const event of eventBus.after(user.id, lastEventId)) {
      writeSseEvent(reply.raw, event)
    }

    const unsubscribe = eventBus.subscribe(user.id, (event) => writeSseEvent(reply.raw, event))
    request.raw.on('close', unsubscribe)
  }
}

export function registerEventsRoute(app: FastifyInstance, eventBus: EventBus): void {
  app.register(
    async (instance) => {
      instance.get('/events', createEventsHandler(eventBus))
    },
    { prefix: '/acquisition-api/v1' }
  )
}
