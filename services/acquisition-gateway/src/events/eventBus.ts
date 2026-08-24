import type { AcquisitionEvent } from '@abs/acquisition-contract'

const MAX_EVENTS_PER_USER = 100

type Listener = (event: AcquisitionEvent) => void

/** Per-user, in-memory, replayable event log for the SSE queue feed. Deliberately not
 * durable: on restart the reconciler's catch-up pass re-derives current state directly from
 * Librarr, so losing buffered events on a gateway restart is not a correctness issue, only
 * a missed animation. */
export class EventBus {
  private eventsByUser = new Map<string, AcquisitionEvent[]>()
  private listenersByUser = new Map<string, Set<Listener>>()
  private seq = 0

  publish(userId: string, event: Pick<AcquisitionEvent, 'type' | 'acquisitionId'>): AcquisitionEvent {
    const full: AcquisitionEvent = {
      id: String(++this.seq),
      type: event.type,
      acquisitionId: event.acquisitionId,
      occurredAt: new Date().toISOString()
    }
    const list = this.eventsByUser.get(userId) ?? []
    list.push(full)
    if (list.length > MAX_EVENTS_PER_USER) list.shift()
    this.eventsByUser.set(userId, list)
    for (const listener of this.listenersByUser.get(userId) ?? []) listener(full)
    return full
  }

  /** Events strictly after `lastEventId` ("0" replays everything currently buffered). */
  after(userId: string, lastEventId: string): AcquisitionEvent[] {
    const list = this.eventsByUser.get(userId) ?? []
    const lastId = Number(lastEventId) || 0
    return list.filter((e) => Number(e.id) > lastId)
  }

  subscribe(userId: string, listener: Listener): () => void {
    const set = this.listenersByUser.get(userId) ?? new Set<Listener>()
    set.add(listener)
    this.listenersByUser.set(userId, set)
    return () => {
      set.delete(listener)
    }
  }
}
