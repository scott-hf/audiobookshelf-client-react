import type { AbsAuthorsShelf, AbsBookShelf, AbsSeriesShelf, AbsShelf } from '../types/abs'

/**
 * Shelf ids built from the user's listening history. The user prioritises these over `discover`
 * (random unstarted books), so [orderShelvesHistoryFirst] floats them to the top in this order.
 * Ids the server doesn't send are simply absent; nothing depends on any of them existing.
 */
export const HISTORY_SHELF_IDS = ['continue-listening', 'continue-series', 'listen-again'] as const

/** True for a shelf built from listening history. */
export function isHistoryShelf(shelf: Pick<AbsShelf, 'id'>): boolean {
  return (HISTORY_SHELF_IDS as readonly string[]).includes(shelf.id)
}

/**
 * Stable reorder: history shelves first (in [HISTORY_SHELF_IDS] order), every other shelf --
 * including ones this client has never heard of -- after them in the order the server sent.
 * Never drops a shelf.
 */
export function orderShelvesHistoryFirst<T extends Pick<AbsShelf, 'id'>>(shelves: readonly T[]): T[] {
  const rank = (shelf: T) => {
    const index = (HISTORY_SHELF_IDS as readonly string[]).indexOf(shelf.id)
    return index === -1 ? HISTORY_SHELF_IDS.length : index
  }
  // Array.prototype.sort is stable (ES2019), so equal ranks keep server order.
  return [...shelves].sort((a, b) => rank(a) - rank(b))
}

/** Narrowing guards. Check `entities` is an array too: a malformed shelf must be skippable. */
export function isBookShelf(shelf: AbsShelf): shelf is AbsBookShelf {
  return shelf.type === 'book' && Array.isArray(shelf.entities)
}

export function isSeriesShelf(shelf: AbsShelf): shelf is AbsSeriesShelf {
  return shelf.type === 'series' && Array.isArray(shelf.entities)
}

export function isAuthorsShelf(shelf: AbsShelf): shelf is AbsAuthorsShelf {
  return shelf.type === 'authors' && Array.isArray(shelf.entities)
}

/** True when a shelf has something worth rendering (the server can send empty shelves). */
export function hasEntities(shelf: AbsShelf): boolean {
  return Array.isArray(shelf.entities) && shelf.entities.length > 0
}
