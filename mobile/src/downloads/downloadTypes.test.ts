import { describe, expect, it } from 'vitest'
import { toDownloadSnapshot, withoutOrphanedComplete, type LocalLibraryItem } from './downloadTypes'

describe('toDownloadSnapshot', () => {
  it('clamps aggregate progress and distinguishes queued from complete', () => {
    expect(toDownloadSnapshot({ id: 'b1', bytesDownloaded: 150, totalBytes: 100, state: 'running' })).toMatchObject({
      progressPercent: 100,
      state: 'running'
    })
    expect(toDownloadSnapshot({ id: 'b2', bytesDownloaded: 0, totalBytes: 0, state: 'queued' }).progressPercent).toBeNull()
  })

  it('carries libraryItemId/title/error through unchanged', () => {
    const snapshot = toDownloadSnapshot({
      id: 'b3',
      libraryItemId: 'item-1',
      title: 'Some Book',
      bytesDownloaded: 50,
      totalBytes: 200,
      state: 'failed',
      error: 'disk full'
    })
    expect(snapshot).toMatchObject({
      id: 'b3',
      libraryItemId: 'item-1',
      title: 'Some Book',
      progressPercent: 25,
      state: 'failed',
      error: 'disk full'
    })
  })

  it('defaults libraryItemId/title/error when absent from the raw event', () => {
    const snapshot = toDownloadSnapshot({ id: 'b4', bytesDownloaded: 10, totalBytes: 40, state: 'paused' })
    expect(snapshot).toMatchObject({ id: 'b4', libraryItemId: '', title: '', progressPercent: 25, error: null })
  })
})

describe('withoutOrphanedComplete', () => {
  const local = (libraryItemId: string): LocalLibraryItem => ({ libraryItemId, serverConnectionId: 'c', folderUri: '/x', manifestJson: '{}', completedAt: 1 })
  const entry = (id: string, state: 'complete' | 'running' | 'failed') => toDownloadSnapshot({ id, libraryItemId: id, bytesDownloaded: 1, totalBytes: 2, state })

  it('drops a complete row that has no offline-library entry (deleted or files missing)', () => {
    const queue = [entry('gone', 'complete'), entry('kept', 'complete')]
    expect(withoutOrphanedComplete(queue, [local('kept')]).map((e) => e.id)).toEqual(['kept'])
  })

  it('leaves in-flight and failed rows alone even without a local entry', () => {
    const queue = [entry('a', 'running'), entry('b', 'failed')]
    expect(withoutOrphanedComplete(queue, [])).toEqual(queue)
  })
})
