import { describe, expect, it } from 'vitest'
import type { LocalLibraryItem } from '../downloads/downloadTypes'
import { localCoverSrc, parseLocalManifest, selectPlaybackSource } from './offlineSource'

const item = { id: 'book-1' }

function localItem(manifestJson: string): LocalLibraryItem {
  return { libraryItemId: 'book-1', serverConnectionId: 'https://books.test', folderUri: '/downloads/book-1', manifestJson, completedAt: 1 }
}

describe('parseLocalManifest', () => {
  it('parses a complete manifest into ordered local tracks', () => {
    const manifest = parseLocalManifest(
      localItem(
        JSON.stringify({
          libraryItemId: 'book-1',
          title: 'Project Hail Mary',
          tracks: [
            { trackIndex: 1, filename: 'part2.mp3', path: '/data/downloads/book-1/part2.mp3' },
            { trackIndex: 0, filename: 'part1.mp3', path: '/data/downloads/book-1/part1.mp3' }
          ]
        })
      )
    )

    expect(manifest).toEqual({
      complete: true,
      title: 'Project Hail Mary',
      tracks: [
        { index: 0, contentUrl: 'file:///data/downloads/book-1/part1.mp3', duration: 0 },
        { index: 1, contentUrl: 'file:///data/downloads/book-1/part2.mp3', duration: 0 }
      ]
    })
  })

  it('passes through an already-scheme-qualified content:// path untouched', () => {
    const manifest = parseLocalManifest(localItem(JSON.stringify({ tracks: [{ trackIndex: 0, path: 'content://com.hellofriend.shelfdroid/downloads/book-1/part1.mp3' }] })))
    expect(manifest?.tracks[0]?.contentUrl).toBe('content://com.hellofriend.shelfdroid/downloads/book-1/part1.mp3')
  })

  it('treats a manifest with no tracks as partial', () => {
    expect(parseLocalManifest(localItem(JSON.stringify({ tracks: [] })))).toEqual({ complete: false, tracks: [] })
  })

  it('treats a manifest with a track missing its local path as partial', () => {
    const manifest = parseLocalManifest(localItem(JSON.stringify({ tracks: [{ trackIndex: 0, path: '/data/downloads/book-1/part1.mp3' }, { trackIndex: 1 }] })))
    expect(manifest?.complete).toBe(false)
  })

  it('treats malformed manifest JSON as partial rather than throwing', () => {
    expect(parseLocalManifest(localItem('not json'))).toEqual({ complete: false, tracks: [] })
  })

  it('returns null when there is no local record', () => {
    expect(parseLocalManifest(null)).toBeNull()
    expect(parseLocalManifest(undefined)).toBeNull()
  })
})

describe('selectPlaybackSource', () => {
  const completeLocalManifest = parseLocalManifest(localItem(JSON.stringify({ tracks: [{ trackIndex: 0, path: '/data/downloads/book-1/part1.mp3' }] })))
  const partialLocalManifest = parseLocalManifest(localItem(JSON.stringify({ tracks: [] })))

  it('prefers a complete local manifest and never uses a partial item', () => {
    expect(selectPlaybackSource(item, completeLocalManifest)).toMatchObject({ kind: 'offline' })
    expect(selectPlaybackSource(item, partialLocalManifest)).toMatchObject({ kind: 'stream' })
  })

  it('falls back to streaming when there is no local record at all', () => {
    expect(selectPlaybackSource(item, null)).toEqual({ kind: 'stream', itemId: 'book-1' })
  })
})

describe('parseLocalManifest presentation metadata', () => {
  it('still parses an old manifest (no metadata fields) as complete with zero durations and no metadata', () => {
    const manifest = parseLocalManifest(localItem(JSON.stringify({ libraryItemId: 'book-1', tracks: [{ trackIndex: 0, filename: 'a.mp3', path: '/d/a.mp3', size: 5, sizeVerified: true }] })))
    expect(manifest?.complete).toBe(true)
    expect(manifest?.tracks).toEqual([{ index: 0, contentUrl: 'file:///d/a.mp3', duration: 0 }])
    expect(manifest?.author).toBeUndefined()
    expect(manifest?.coverPath).toBeUndefined()
    expect(manifest?.chapters).toBeUndefined()
    expect(manifest?.duration).toBeUndefined()
  })

  it('parses author, narrator, durations, cover and chapters', () => {
    const manifest = parseLocalManifest(
      localItem(
        JSON.stringify({
          title: 'Book',
          author: 'Andy Weir',
          narrator: 'Ray Porter',
          duration: 300,
          coverPath: '/d/cover.jpg',
          chapters: [
            { id: 1, start: 100, end: 300, title: 'Two' },
            { id: 0, start: 0, end: 100, title: 'One' },
            { nonsense: true }
          ],
          tracks: [
            { trackIndex: 1, path: '/d/b.mp3', duration: 120.5 },
            { trackIndex: 0, path: '/d/a.mp3', duration: 179.5 }
          ]
        })
      )
    )
    expect(manifest).toMatchObject({ complete: true, title: 'Book', author: 'Andy Weir', narrator: 'Ray Porter', duration: 300, coverPath: '/d/cover.jpg' })
    expect(manifest?.tracks.map((track) => track.duration)).toEqual([179.5, 120.5])
    expect(manifest?.chapters).toEqual([
      { id: 0, start: 0, end: 100, title: 'One' },
      { id: 1, start: 100, end: 300, title: 'Two' }
    ])
  })

  it('ignores malformed metadata values without affecting completeness', () => {
    const manifest = parseLocalManifest(localItem(JSON.stringify({ author: 5, duration: -3, coverPath: '', chapters: 'x', tracks: [{ trackIndex: 0, path: '/d/a.mp3', duration: 'long' }] })))
    expect(manifest?.complete).toBe(true)
    expect(manifest?.author).toBeUndefined()
    expect(manifest?.duration).toBeUndefined()
    expect(manifest?.coverPath).toBeUndefined()
    expect(manifest?.chapters).toBeUndefined()
    expect(manifest?.tracks[0]?.duration).toBe(0)
  })
})

describe('localCoverSrc', () => {
  it('returns null without a cover path and a file URL otherwise', () => {
    expect(localCoverSrc(undefined)).toBeNull()
    expect(localCoverSrc('/d/cover.jpg')).toContain('/d/cover.jpg')
  })
})
