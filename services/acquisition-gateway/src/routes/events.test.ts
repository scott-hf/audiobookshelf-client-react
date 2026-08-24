import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { EventBus } from '../events/eventBus'
import { createEventsHandler } from './events'

describe('EventBus', () => {
  it('never exposes another user queue and replays events after Last-Event-ID', () => {
    const bus = new EventBus()
    bus.publish('u1', { type: 'acquisition.created', acquisitionId: 'a1' })
    bus.publish('u2', { type: 'acquisition.created', acquisitionId: 'a2' })

    expect(bus.after('u1', '0')).toHaveLength(1)
    expect(bus.after('u1', '0')[0]).toMatchObject({ acquisitionId: 'a1' })
    expect(bus.after('u2', '0')).toHaveLength(1)
    expect(bus.after('u2', '0')[0]).toMatchObject({ acquisitionId: 'a2' })
  })

  it('only replays events strictly after the given id', () => {
    const bus = new EventBus()
    const first = bus.publish('u1', { type: 'acquisition.created', acquisitionId: 'a1' })
    bus.publish('u1', { type: 'acquisition.updated', acquisitionId: 'a1' })
    expect(bus.after('u1', first.id)).toHaveLength(1)
  })

  it('caps buffered events at 100 per user', () => {
    const bus = new EventBus()
    for (let i = 0; i < 150; i++) bus.publish('u1', { type: 'acquisition.updated', acquisitionId: `a${i}` })
    expect(bus.after('u1', '0')).toHaveLength(100)
  })

  it('pushes live events only to subscribers of the matching user', () => {
    const bus = new EventBus()
    const seenU1: string[] = []
    const seenU2: string[] = []
    bus.subscribe('u1', (e) => seenU1.push(e.acquisitionId))
    bus.subscribe('u2', (e) => seenU2.push(e.acquisitionId))
    bus.publish('u1', { type: 'acquisition.updated', acquisitionId: 'a1' })
    expect(seenU1).toEqual(['a1'])
    expect(seenU2).toEqual([])
  })
})

function fakeReply(): { raw: { writeHead: (...args: unknown[]) => void; write: (chunk: string) => void }; writes: string[] } {
  const writes: string[] = []
  return {
    raw: {
      writeHead: () => {},
      write: (chunk: string) => {
        writes.push(chunk)
      }
    },
    writes
  }
}

describe('createEventsHandler', () => {
  it('replays buffered events since Last-Event-ID then streams live pushes, scoped to the user', async () => {
    const bus = new EventBus()
    const buffered = bus.publish('u1', { type: 'acquisition.created', acquisitionId: 'a1' })

    const reply = { ...fakeReply(), hijack: () => {} } as unknown as import('fastify').FastifyReply
    const rawReq = new EventEmitter()
    const request = {
      absUser: { id: 'u1' },
      headers: { 'last-event-id': '0' },
      raw: rawReq
    } as unknown as import('fastify').FastifyRequest

    const handler = createEventsHandler(bus)
    await handler(request, reply)

    const writesSoFar = (reply as unknown as { writes: string[] }).writes
    expect(writesSoFar.join('')).toContain(buffered.id)
    expect(writesSoFar.join('')).toContain('a1')

    bus.publish('u1', { type: 'acquisition.updated', acquisitionId: 'a2' })
    bus.publish('u2', { type: 'acquisition.updated', acquisitionId: 'other-user' })

    const allWrites = (reply as unknown as { writes: string[] }).writes.join('')
    expect(allWrites).toContain('a2')
    expect(allWrites).not.toContain('other-user')

    rawReq.emit('close')
    bus.publish('u1', { type: 'acquisition.updated', acquisitionId: 'a3-after-close' })
    expect((reply as unknown as { writes: string[] }).writes.join('')).not.toContain('a3-after-close')
  })
})
