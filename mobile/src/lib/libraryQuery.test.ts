import { describe, expect, it } from 'vitest'
import { authorFilter, genreFilter, parseFilter, seriesFilter } from './filterUtils'
import { DEFAULT_LIBRARY_QUERY, LIBRARY_SORT_OPTIONS, libraryBooksPath, libraryFilterPath, parseLibraryQuery, toSearchParams, type LibraryQuery } from './libraryQuery'

const query = (overrides: Partial<LibraryQuery>): LibraryQuery => ({ ...DEFAULT_LIBRARY_QUERY, ...overrides })

describe('libraryQuery URL state', () => {
  it('writes nothing for the default query', () => {
    expect(toSearchParams(DEFAULT_LIBRARY_QUERY).toString()).toBe('')
    expect(parseLibraryQuery(new URLSearchParams(''))).toEqual(DEFAULT_LIBRARY_QUERY)
  })

  it('round-trips the server filter string byte for byte (no double encoding)', () => {
    // Includes base64 padding (%3D), '+' and '/' (%2B, %2F), commas and an ampersand: everything that
    // would corrupt if the URL layer and filterUtils both decoded or both left the value alone.
    for (const genre of ['Action & Adventure', 'Adventure, Space Opera, Military', '??>', 'ab', 'Audiobooks']) {
      const filter = genreFilter(genre)
      const search = toSearchParams(query({ filter })).toString()
      const parsed = parseLibraryQuery(new URLSearchParams(search))
      expect(parsed.filter).toBe(filter)
      expect(parseFilter(parsed.filter)).toEqual({ group: 'genres', value: genre })
    }
  })

  it('round-trips sort, direction and the downloaded flag', () => {
    const original = query({ sort: 'addedAt', desc: true, downloaded: true, filter: genreFilter('Adventure') })
    expect(parseLibraryQuery(toSearchParams(original))).toEqual(original)
  })

  it('drops a filter the server could not parse, and the label that went with it', () => {
    expect(parseLibraryQuery(new URLSearchParams('filter=nonsense&label=Bob')).filter).toBeNull()
    expect(parseLibraryQuery(new URLSearchParams('filter=nonsense&label=Bob')).label).toBeNull()
    expect(parseLibraryQuery(new URLSearchParams('filter=bogusgroup.QQ%3D%3D')).filter).toBeNull()
  })

  it('falls back to the default sort for an unknown key', () => {
    expect(parseLibraryQuery(new URLSearchParams('sort=media.metadata.nope')).sort).toBe(DEFAULT_LIBRARY_QUERY.sort)
    expect(parseLibraryQuery(new URLSearchParams('sort=random')).sort).toBe(DEFAULT_LIBRARY_QUERY.sort)
  })

  it('offers only keys the server confirmed, none of them paging-unsafe', () => {
    const keys = LIBRARY_SORT_OPTIONS.map((option) => option.key)
    expect(keys).not.toContain('random')
    expect(keys).toEqual(expect.arrayContaining(['media.metadata.title', 'addedAt', 'media.duration']))
  })
})

describe('libraryFilterPath', () => {
  it('targets the flat books route of the library', () => {
    expect(libraryBooksPath('lib 1')).toBe('/library/lib%201/books')
  })

  it('builds author and series links from the entity id, carrying the name only as a label', () => {
    const author = libraryFilterPath('lib', 'authors', 'au_1', 'Andy Weir')
    const authorParams = new URLSearchParams(author.split('?')[1])
    expect(authorParams.get('filter')).toBe(authorFilter('au_1'))
    expect(authorParams.get('filter')).not.toBe(authorFilter('Andy Weir'))
    expect(authorParams.get('label')).toBe('Andy Weir')

    const series = new URLSearchParams(libraryFilterPath('lib', 'series', 'se_1', 'The Expanse').split('?')[1])
    expect(series.get('filter')).toBe(seriesFilter('se_1'))
  })

  it('leaves the label off when none is given', () => {
    expect(new URLSearchParams(libraryFilterPath('lib', 'genres', 'Adventure').split('?')[1]).has('label')).toBe(false)
  })
})
