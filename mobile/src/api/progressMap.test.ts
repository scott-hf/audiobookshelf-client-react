import { describe, expect, it } from 'vitest'
import type { AbsUserMediaProgress } from '../types/abs'
import { buildProgressMap, EMPTY_PROGRESS_MAP, getProgress, progressKey } from './progressMap'

function row(overrides: Partial<AbsUserMediaProgress> & { libraryItemId: string }): AbsUserMediaProgress {
  return { id: `mp-${overrides.libraryItemId}`, progress: 0.25, currentTime: 25, duration: 100, isFinished: false, ...overrides }
}

describe('progressKey', () => {
  it('uses the item id alone for books and item-episode for episodes', () => {
    expect(progressKey('li_1')).toBe('li_1')
    expect(progressKey('li_1', null)).toBe('li_1')
    expect(progressKey('li_1', undefined)).toBe('li_1')
    expect(progressKey('li_1', 'ep_9')).toBe('li_1-ep_9')
  })
})

describe('buildProgressMap', () => {
  it('indexes books and episodes under separate keys', () => {
    const book = row({ libraryItemId: 'li_1', episodeId: null, progress: 0.5 })
    const episode = row({ libraryItemId: 'li_2', episodeId: 'ep_1', progress: 0.75 })
    const map = buildProgressMap([book, episode])

    expect(getProgress(map, 'li_1')).toBe(book)
    expect(getProgress(map, 'li_2', 'ep_1')).toBe(episode)
    // An episode's progress must not leak onto its podcast item, nor the reverse.
    expect(getProgress(map, 'li_2')).toBeUndefined()
    expect(getProgress(map, 'li_1', 'ep_1')).toBeUndefined()
  })

  it('returns undefined for an item the user never started', () => {
    expect(getProgress(buildProgressMap([row({ libraryItemId: 'li_1' })]), 'li_other')).toBeUndefined()
  })

  it('lets a later row for the same key win', () => {
    const older = row({ libraryItemId: 'li_1', progress: 0.1 })
    const newer = row({ libraryItemId: 'li_1', progress: 0.9 })
    expect(getProgress(buildProgressMap([older, newer]), 'li_1')?.progress).toBe(0.9)
  })

  it('tolerates a missing list (older/odd server responses)', () => {
    expect(buildProgressMap(undefined).size).toBe(0)
    expect(buildProgressMap(null).size).toBe(0)
    expect(EMPTY_PROGRESS_MAP.size).toBe(0)
  })
})
