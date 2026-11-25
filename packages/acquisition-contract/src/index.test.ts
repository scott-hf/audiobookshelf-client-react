import { describe, expect, it } from 'vitest'
import { AcquisitionSchema, CreateAcquisitionBodySchema, DiscoverBrowseQuerySchema, SearchQuerySchema } from './index'

describe('acquisition contract', () => {
  it('rejects progress outside 0..100', () => {
    expect(() =>
      AcquisitionSchema.parse({
        id: 'a1',
        libraryId: 'lib1',
        title: 'Book',
        author: 'Author',
        state: 'downloading',
        progressPercent: 101,
        createdAt: '2026-08-24T00:00:00.000Z',
        updatedAt: '2026-08-24T00:00:00.000Z'
      })
    ).toThrow()
  })

  describe('typed text is trimmed before it is validated', () => {
    it('trims a padded search query, so padded and unpadded forms are the same value', () => {
      expect(SearchQuerySchema.parse({ libraryId: 'lib1', q: '  dune \n' }).q).toBe('dune')
      expect(SearchQuerySchema.parse({ libraryId: 'lib1', q: 'dune' })).toEqual(SearchQuerySchema.parse({ libraryId: 'lib1', q: ' dune ' }))
    })

    it('rejects a whitespace-only search query the same way as an empty one', () => {
      const empty = SearchQuerySchema.safeParse({ libraryId: 'lib1', q: '' })
      const blank = SearchQuerySchema.safeParse({ libraryId: 'lib1', q: ' \t\n ' })
      expect(empty.success).toBe(false)
      expect(blank.success).toBe(false)
      expect(blank.success === false && blank.error.issues.map((i) => [i.code, i.path])).toEqual(empty.success === false ? empty.error.issues.map((i) => [i.code, i.path]) : [])
    })

    it('keeps interior whitespace in a search query', () => {
      expect(SearchQuerySchema.parse({ libraryId: 'lib1', q: ' project  hail mary ' }).q).toBe('project  hail mary')
    })

    it('does not trim the opaque libraryId (a padded id is a different, unknown id)', () => {
      expect(SearchQuerySchema.parse({ libraryId: ' lib1 ', q: 'x' }).libraryId).toBe(' lib1 ')
    })

    it('trims a browse genre, and a whitespace-only genre collapses to empty (= no genre)', () => {
      expect(DiscoverBrowseQuerySchema.parse({ catalog: 'popular', genre: ' science fiction ' }).genre).toBe('science fiction')
      expect(DiscoverBrowseQuerySchema.parse({ catalog: 'popular', genre: '   ' }).genre).toBe('')
    })

    it('does not trim the browse catalog id, so a padded one is not silently accepted as another', () => {
      expect(DiscoverBrowseQuerySchema.parse({ catalog: ' popular' }).catalog).toBe(' popular')
    })
  })

  it('requires opaque release identity and idempotency', () => {
    expect(
      CreateAcquisitionBodySchema.parse({
        searchSessionId: 'search_12345678',
        releaseId: 'release_12345678',
        idempotencyKey: crypto.randomUUID()
      })
    ).toBeTruthy()
  })
})
