import { describe, expect, it } from 'vitest'
import type { AbsShelf } from '../types/abs'
import { hasEntities, isAuthorsShelf, isBookShelf, isHistoryShelf, isSeriesShelf, orderShelvesHistoryFirst } from './shelfUtils'

function shelf(id: string, type: string = 'book', entities: unknown[] = [{}]): AbsShelf {
  return { id, label: id, labelStringKey: `Label-${id}`, type, entities, total: entities.length }
}

describe('orderShelvesHistoryFirst', () => {
  it('floats history shelves to the top in a fixed order and keeps server order for the rest', () => {
    const sent = [shelf('recently-added'), shelf('discover'), shelf('listen-again'), shelf('mystery-new-shelf', 'weird'), shelf('continue-series'), shelf('continue-listening')]
    expect(orderShelvesHistoryFirst(sent).map((s) => s.id)).toEqual([
      'continue-listening',
      'continue-series',
      'listen-again',
      'recently-added',
      'discover',
      'mystery-new-shelf'
    ])
  })

  it('never drops or mutates anything, including unknown shelves', () => {
    const sent = [shelf('a', 'unknown-type'), shelf('b')]
    const ordered = orderShelvesHistoryFirst(sent)
    expect(ordered).toHaveLength(2)
    expect(ordered).not.toBe(sent)
    expect(sent.map((s) => s.id)).toEqual(['a', 'b'])
  })

  it('works when only some history shelves exist', () => {
    expect(orderShelvesHistoryFirst([shelf('discover'), shelf('listen-again')]).map((s) => s.id)).toEqual(['listen-again', 'discover'])
  })
})

describe('isHistoryShelf', () => {
  it('flags the three history ids only', () => {
    expect(['continue-listening', 'continue-series', 'listen-again'].every((id) => isHistoryShelf({ id }))).toBe(true)
    expect(isHistoryShelf({ id: 'discover' })).toBe(false)
  })
})

describe('type guards', () => {
  it('narrow by type and reject unknown or malformed shelves', () => {
    expect(isBookShelf(shelf('x', 'book'))).toBe(true)
    expect(isSeriesShelf(shelf('x', 'series'))).toBe(true)
    expect(isAuthorsShelf(shelf('x', 'authors'))).toBe(true)
    expect(isBookShelf(shelf('x', 'series'))).toBe(false)
    expect(isBookShelf(shelf('x', 'episode'))).toBe(false)
    expect(isBookShelf(shelf('x', 'brand-new-type'))).toBe(false)
    expect(isBookShelf({ ...shelf('x', 'book'), entities: undefined as unknown as unknown[] })).toBe(false)
  })

  it('hasEntities is false for empty or missing entity lists', () => {
    expect(hasEntities(shelf('x', 'book', []))).toBe(false)
    expect(hasEntities({ ...shelf('x'), entities: undefined as unknown as unknown[] })).toBe(false)
    expect(hasEntities(shelf('x'))).toBe(true)
  })
})
