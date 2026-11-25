import { describe, expect, it } from 'vitest'
import { AcquisitionSchema, CreateAcquisitionBodySchema, DiscoverBrowseQuerySchema, SearchQuerySchema, SearchReleaseSchema, SearchResponseSchema } from './index'

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

  // The client is a sideloaded APK that may be older than the gateway (or newer). These pin the
  // wire shapes of BOTH generations so neither deploy order breaks Discover search.
  describe('SearchRelease is order-independent across client and gateway versions', () => {
    const base = {
      releaseId: 'release_12345678',
      title: 'The Children of Hurin - J.R.R. Tolkien',
      author: '',
      narrators: [],
      sizeBytes: null,
      durationSeconds: null,
      sourceLabel: 'AudioBookBay',
      seeders: null,
      coverUrl: null,
      alreadyOwned: false,
      existingAbsItemId: null,
      requestable: true
    }
    // What a pre-f88ee163 gateway sends: no `sizeLabel`, sentinel format, `qualityLabel` present.
    const oldGatewayRow = { ...base, format: 'unknown', qualityLabel: 'Unknown' }
    // What the current gateway sends: the same legacy fields PLUS the additive `sizeLabel`.
    const newGatewayRow = { ...base, format: 'unknown', qualityLabel: 'Unknown', sizeLabel: '1.2 GB' }

    it('NEW client schema parses an OLD gateway response (no sizeLabel key)', () => {
      const parsed = SearchResponseSchema.parse({ searchSessionId: 'search_12345678', results: [oldGatewayRow] })
      expect(parsed.results[0].format).toBe('unknown')
      expect(parsed.results[0].sizeLabel).toBeUndefined()
    })

    it('NEW client schema parses a NEW gateway response (with sizeLabel, string or null)', () => {
      const parsed = SearchResponseSchema.parse({ searchSessionId: 'search_12345678', results: [newGatewayRow, { ...newGatewayRow, sizeLabel: null }] })
      expect(parsed.results.map((r) => r.sizeLabel)).toEqual(['1.2 GB', null])
    })

    it('OLD client schema (pre-f88ee163, no sizeLabel, qualityLabel required) parses a NEW gateway response', () => {
      // Reconstruct the old bundled schema: the current one minus `sizeLabel`. zod strips the
      // unknown key, so the extra field a new gateway sends is harmless.
      const oldClientSchema = SearchReleaseSchema.omit({ sizeLabel: true })
      const parsed = oldClientSchema.parse(newGatewayRow)
      expect(parsed.qualityLabel).toBe('Unknown')
      expect(parsed.format.toUpperCase()).toBe('UNKNOWN')
      expect(parsed).not.toHaveProperty('sizeLabel')
    })

    it('still requires a non-null string format and a qualityLabel, so an old client never sees null', () => {
      expect(SearchReleaseSchema.safeParse({ ...oldGatewayRow, format: null }).success).toBe(false)
      const { qualityLabel: _omitted, ...withoutQuality } = oldGatewayRow
      expect(SearchReleaseSchema.safeParse(withoutQuality).success).toBe(false)
    })
  })
})
