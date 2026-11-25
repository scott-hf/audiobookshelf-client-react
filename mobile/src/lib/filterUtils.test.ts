import { describe, expect, it } from 'vitest'
import {
  authorFilter,
  buildFilter,
  filterDecode,
  filterEncode,
  FILTER_GROUPS,
  genreFilter,
  narratorFilter,
  parseFilter,
  PROGRESS_FILTER_VALUES,
  progressFilter,
  seriesFilter,
  tagFilter
} from './filterUtils'

describe('filterEncode / filterDecode', () => {
  it('base64-encodes then URL-encodes, so padding and slashes survive a query string', () => {
    // "Sci-Fi" -> base64 "U2NpLUZp" (no padding); "ab" -> "YWI=" whose "=" must become %3D.
    expect(filterEncode('Sci-Fi')).toBe('U2NpLUZp')
    expect(filterEncode('ab')).toBe('YWI%3D')
    // "??>" encodes to "Pz8+" -- the "+" must be escaped or a query parser turns it into a space.
    expect(filterEncode('??>')).toBe('Pz8%2B')
  })

  it('round-trips ASCII, unicode and punctuation', () => {
    for (const value of ['Fantasy', 'Science Fiction & Fantasy', 'Müller', '日本語', 'Café ☕', 'a/b+c=d', 'ab', '']) {
      expect(filterDecode(filterEncode(value))).toBe(value)
    }
  })

  it('round-trips an entity id', () => {
    const id = 'f4c6a3d2-0a1b-4c3d-9e8f-123456789abc'
    expect(filterDecode(filterEncode(id))).toBe(id)
  })
})

describe('typed filter builders', () => {
  it('prefixes the group and encodes the value', () => {
    expect(genreFilter('Fantasy')).toBe(`genres.${filterEncode('Fantasy')}`)
    expect(tagFilter('Cozy')).toBe(`tags.${filterEncode('Cozy')}`)
    expect(narratorFilter('Rob Inglis')).toBe(`narrators.${filterEncode('Rob Inglis')}`)
    expect(buildFilter('publishedDecades', '2010')).toBe(`publishedDecades.${filterEncode('2010')}`)
  })

  it('encodes the ENTITY ID for authors and series, so the name would produce a different filter', () => {
    const author = { id: 'au_1', name: 'Brandon Sanderson' }
    const series = { id: 'se_1', name: 'Mistborn' }
    expect(authorFilter(author.id)).toBe(`authors.${filterEncode('au_1')}`)
    expect(authorFilter(author.id)).not.toBe(authorFilter(author.name))
    expect(seriesFilter(series.id)).toBe(`series.${filterEncode('se_1')}`)
    expect(seriesFilter(series.id)).not.toBe(seriesFilter(series.name))
  })

  it('encodes every progress value verbatim', () => {
    expect(PROGRESS_FILTER_VALUES).toEqual(['finished', 'in-progress', 'not-started', 'not-finished'])
    for (const value of PROGRESS_FILTER_VALUES) {
      expect(progressFilter(value)).toBe(`progress.${filterEncode(value)}`)
    }
  })
})

describe('parseFilter', () => {
  it('recovers group and value for every known group', () => {
    for (const group of FILTER_GROUPS) {
      expect(parseFilter(buildFilter(group, 'Some Value/1'))).toEqual({ group, value: 'Some Value/1' })
    }
  })

  it('recovers an id for authors/series filters', () => {
    expect(parseFilter(authorFilter('au_42'))).toEqual({ group: 'authors', value: 'au_42' })
    expect(parseFilter(seriesFilter('se_42'))).toEqual({ group: 'series', value: 'se_42' })
  })

  it('returns null for empty, unknown-group, valueless and undecodable input', () => {
    expect(parseFilter(null)).toBeNull()
    expect(parseFilter('')).toBeNull()
    expect(parseFilter('issues')).toBeNull()
    expect(parseFilter('bogus.abc')).toBeNull()
    expect(parseFilter('genres.!!!not-base64!!!')).toBeNull()
  })
})
