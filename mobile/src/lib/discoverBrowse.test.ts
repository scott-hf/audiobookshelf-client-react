import type { DiscoverItem, DiscoverOptionsResponse } from '@abs/acquisition-contract'
import { describe, expect, it } from 'vitest'
import type { AbsLibraryItem } from '../types/abs'
import {
  DEFAULT_DISCOVER_QUERY,
  FOR_YOU,
  FOR_YOU_ID,
  GENRE_ALL_ID,
  NOISE_GENRES,
  POPULAR_CATALOG_ID,
  authorTokens,
  bookWeight,
  browseCatalogs,
  buildOwnedIndex,
  cleanGenres,
  findOwned,
  mergeCards,
  nextSelectionOnGenre,
  normalizeTitle,
  parseDiscoverQuery,
  passesGate,
  toDiscoverSearchParams,
  topGenres,
  type BrowseSelection,
  type DiscoverQuery,
  type ListenedBook
} from './discoverBrowse'

const options: DiscoverOptionsResponse = {
  catalogs: [
    { id: 'new', label: 'New' },
    { id: 'popular', label: 'Popular' },
    { id: FOR_YOU_ID, label: 'Server impostor' }
  ],
  genres: [
    { id: 'fantasy', label: 'Fantasy' },
    { id: 'science fiction', label: 'Science Fiction' }
  ]
}

const query = (overrides: Partial<DiscoverQuery>): DiscoverQuery => ({ ...DEFAULT_DISCOVER_QUERY, ...overrides })
const catalog = (catalogId: string, genreId: string | null = null, genreLabel: string | null = null): BrowseSelection => ({ kind: 'catalog', catalogId, genreId, genreLabel })
const parse = (search: string, opts: DiscoverOptionsResponse | null = options) => parseDiscoverQuery(new URLSearchParams(search), opts)

describe('discover URL state', () => {
  it('defaults to search mode, the Popular catalog, and writes nothing', () => {
    expect(DEFAULT_DISCOVER_QUERY.mode).toBe('search')
    expect(DEFAULT_DISCOVER_QUERY.selection).toEqual({ kind: 'catalog', catalogId: POPULAR_CATALOG_ID, genreId: null, genreLabel: null })
    expect(toDiscoverSearchParams(DEFAULT_DISCOVER_QUERY).toString()).toBe('')
    expect(parse('')).toEqual(DEFAULT_DISCOVER_QUERY)
    expect(parse('', null)).toEqual(DEFAULT_DISCOVER_QUERY)
  })

  it('reaches For you only when the URL asks for it, with or without options', () => {
    expect(parse('catalog=for_you').selection).toEqual({ kind: 'forYou' })
    expect(parse('catalog=for_you', null).selection).toEqual({ kind: 'forYou' })
    const original = query({ mode: 'browse', selection: { kind: 'forYou' } })
    expect(toDiscoverSearchParams(original).toString()).toBe('mode=browse&catalog=for_you')
    expect(parse('mode=browse&catalog=for_you')).toEqual(original)
  })

  it('omits mode when it is search and writes it for browse', () => {
    expect(toDiscoverSearchParams(query({ mode: 'search', q: 'dune' })).toString()).toBe('q=dune')
    expect(toDiscoverSearchParams(query({ mode: 'browse' })).toString()).toBe('mode=browse')
  })

  it('round-trips a browse catalog with a genre and its label', () => {
    const original = query({ mode: 'browse', selection: catalog('popular', 'science fiction', 'Science Fiction') })
    const search = toDiscoverSearchParams(original).toString()
    // Popular is the default catalog, so only the genre is written.
    expect(search).toBe('mode=browse&genre=science+fiction&genreLabel=Science+Fiction')
    expect(parse(search)).toEqual(original)

    const other = query({ mode: 'browse', selection: catalog('new', 'fantasy', 'Fantasy') })
    const otherSearch = toDiscoverSearchParams(other).toString()
    expect(otherSearch).toBe('mode=browse&catalog=new&genre=fantasy&genreLabel=Fantasy')
    expect(parse(otherSearch)).toEqual(other)
  })

  it('round-trips a search with awkward characters', () => {
    const original = query({ q: 'Hitchhiker\'s Guide & more = 42?' })
    expect(parse(toDiscoverSearchParams(original).toString())).toEqual(original)
  })

  it('keeps the other mode state while switching tabs', () => {
    const original = query({ mode: 'browse', selection: catalog('new'), q: 'dune' })
    expect(parse(toDiscoverSearchParams(original).toString())).toEqual(original)
  })

  it('falls back to the default (Popular, no genre) for an unknown catalog rather than sending it upstream', () => {
    expect(parse('catalog=nope&genre=fantasy').selection).toEqual(DEFAULT_DISCOVER_QUERY.selection)
    expect(parse('catalog=nope').selection).toEqual(catalog('popular'))
  })

  it('accepts the pinned popular catalog without options, but cannot verify any other', () => {
    expect(parse('catalog=popular&genre=fantasy', null).selection).toEqual(catalog('popular', 'fantasy', null))
    expect(parse('genre=fantasy', null).selection).toEqual(catalog('popular', 'fantasy', null))
    expect(parse('catalog=new', null).selection).toEqual(catalog('popular'))
    expect(parse('catalog=new').selection).toEqual(catalog('new'))
  })

  it('never serialises or parses the For you id as a server catalog', () => {
    expect(browseCatalogs(options).map((entry) => entry.id)).toEqual(['new', 'popular'])
    // A server catalog that claims the client-only id is malformed and writes nothing.
    expect(toDiscoverSearchParams(query({ selection: catalog(FOR_YOU_ID, 'fantasy') })).toString()).toBe('')
  })

  it('never serialises or parses the all-genres sentinel', () => {
    expect(toDiscoverSearchParams(query({ selection: catalog('popular', GENRE_ALL_ID, 'All genres') })).toString()).toBe('')
    expect(toDiscoverSearchParams(query({ selection: catalog('new', GENRE_ALL_ID, 'All genres') })).toString()).toBe('catalog=new')
    expect(parse(`catalog=popular&genre=${GENRE_ALL_ID}&genreLabel=All`).selection).toEqual(catalog('popular'))
  })

  it('does not write a genre label without a genre, and fills a missing label from the options', () => {
    expect(toDiscoverSearchParams(query({ selection: catalog('new', null, 'Orphan label') })).toString()).toBe('catalog=new')
    expect(parse('catalog=popular&genre=fantasy').selection).toEqual(catalog('popular', 'fantasy', 'Fantasy'))
    // A cleaned library genre that Librarr does not list is still a legitimate `genre` value.
    expect(parse('catalog=popular&genre=Space+Opera').selection).toEqual(catalog('popular', 'Space Opera', null))
  })

  it('treats a blank search as no search', () => {
    expect(parse('q=%20%20').q).toBe('')
    expect(toDiscoverSearchParams(query({ q: '   ' })).toString()).toBe('')
  })

  it('treats any mode other than browse as search', () => {
    expect(parse('mode=bogus').mode).toBe('search')
    expect(parse('mode=browse').mode).toBe('browse')
  })
})

describe('nextSelectionOnGenre', () => {
  it('leaves For you for Popular in the picked genre', () => {
    expect(nextSelectionOnGenre({ kind: 'forYou' }, 'fantasy', 'Fantasy', options)).toEqual(catalog('popular', 'fantasy', 'Fantasy'))
  })

  it('falls back to the first real catalog when popular is not listed, skipping the For you id', () => {
    const noPopular: DiscoverOptionsResponse = { ...options, catalogs: [{ id: FOR_YOU_ID, label: 'x' }, { id: 'new', label: 'New' }] }
    expect(nextSelectionOnGenre({ kind: 'forYou' }, 'fantasy', 'Fantasy', noPopular)).toEqual(catalog('new', 'fantasy', 'Fantasy'))
    expect(nextSelectionOnGenre({ kind: 'forYou' }, 'fantasy', 'Fantasy', { ...options, catalogs: [] })).toEqual({ kind: 'forYou' })
  })

  it('leaves For you unchanged when "all genres" is picked', () => {
    const forYou: BrowseSelection = { kind: 'forYou' }
    expect(nextSelectionOnGenre(forYou, null, null, options)).toBe(forYou)
    expect(nextSelectionOnGenre(forYou, GENRE_ALL_ID, 'All genres', options)).toBe(forYou)
  })

  it('sets or clears the genre on a catalog and keeps the catalog', () => {
    const current = catalog('new', 'fantasy', 'Fantasy')
    expect(nextSelectionOnGenre(current, 'science fiction', 'Science Fiction', options)).toEqual(catalog('new', 'science fiction', 'Science Fiction'))
    expect(nextSelectionOnGenre(current, GENRE_ALL_ID, 'All genres', options)).toEqual(catalog('new'))
    expect(nextSelectionOnGenre(current, null, 'ignored', options)).toEqual(catalog('new'))
  })

  it('drops a blank label', () => {
    expect(nextSelectionOnGenre(catalog('new'), 'fantasy', '  ', options)).toEqual(catalog('new', 'fantasy', null))
  })
})

describe('cleanGenres', () => {
  it('tolerates undefined, null and empty input', () => {
    expect(cleanGenres(undefined)).toEqual([])
    expect(cleanGenres(null)).toEqual([])
    expect(cleanGenres([])).toEqual([])
    expect(cleanGenres(['', '  ', ' , '])).toEqual([])
  })

  it('splits comma-joined strings and trims the pieces', () => {
    expect(cleanGenres(['Adventure, Space Opera, Military'])).toEqual(['Adventure', 'Space Opera', 'Military'])
    expect(cleanGenres(['Space Exploration,Space Opera ,  First   Contact'])).toEqual(['Space Exploration', 'Space Opera', 'First Contact'])
  })

  it('drops every measured noise value, in any case', () => {
    const noise = ['Audiobook', 'Audiobooks', 'Books & Spoken', 'Speech', 'Other', 'Two Hours or More (65-100 Pages)']
    expect(cleanGenres(noise)).toEqual([])
    expect(cleanGenres(noise.map((entry) => entry.toUpperCase()))).toEqual([])
    expect(cleanGenres(['  audiobooks  '])).toEqual([])
    for (const entry of noise) expect(NOISE_GENRES.has(entry.toLowerCase())).toBe(true)
    expect(cleanGenres(['Audiobook', 'Memoir', 'Other', 'Philosophy'])).toEqual(['Memoir', 'Philosophy'])
  })

  it('folds scifi into science fiction so the one real signal does not split', () => {
    expect(cleanGenres(['SciFi', 'Science Fiction'])).toEqual(['Science Fiction'])
    expect(cleanGenres(['Science Fiction', 'SciFi'])).toEqual(['Science Fiction'])
    // A lone alias is shown under its canonical name, not the raw variant.
    expect(cleanGenres(['SciFi'])).toEqual(['Science Fiction'])
  })

  it('keeps genuine subgenres distinct from science fiction', () => {
    expect(cleanGenres(['Science Fiction', 'Space Opera', 'Hard Science Fiction', 'Science Fantasy'])).toEqual(['Science Fiction', 'Space Opera', 'Hard Science Fiction', 'Science Fantasy'])
  })

  it('splits a spaced-slash category path (real value) into its pieces', () => {
    expect(cleanGenres(['Fiction / Science Fiction & Fantasy / Hard Science Fiction'])).toEqual(['Fiction', 'Science Fiction & Fantasy', 'Hard Science Fiction'])
  })

  it('applies noise, alias and dedupe handling to slash pieces, and mixes both separators', () => {
    expect(cleanGenres(['Audiobook / SciFi / Science Fiction, Other / Space Opera'])).toEqual(['Science Fiction', 'Space Opera'])
    // An unspaced slash is not a separator.
    expect(cleanGenres(['Sci/Fi'])).toEqual(['Sci/Fi'])
  })

  it('deduplicates case-insensitively and keeps the first spelling', () => {
    expect(cleanGenres(['Fantasy', 'fantasy ', 'FANTASY', 'Adventure, fantasy'])).toEqual(['Fantasy', 'Adventure'])
  })

  it('keeps Audible top-level categories, which are weak but real', () => {
    expect(cleanGenres(['Literature & Fiction', 'Action & Adventure'])).toEqual(['Literature & Fiction', 'Action & Adventure'])
  })
})

describe('normalizeTitle and authorTokens', () => {
  it('matches "The Hobbit (Unabridged)" with "Hobbit"', () => {
    expect(normalizeTitle('The Hobbit (Unabridged)')).toBe('hobbit')
    expect(normalizeTitle('Hobbit')).toBe('hobbit')
    expect(normalizeTitle('The Hobbit')).toBe('hobbit')
  })

  it('ignores case, apostrophes and punctuation', () => {
    expect(normalizeTitle("HARRY POTTER AND THE PHILOSOPHER'S STONE (Unabridged)")).toBe(normalizeTitle('Harry Potter and the Philosophers Stone'))
    expect(normalizeTitle('Dune!')).toBe('dune')
    expect(normalizeTitle('Ender’s Game')).toBe('enders game')
    expect(normalizeTitle('Mistborn: The Final Empire')).toBe('mistborn the final empire')
  })

  it('drops only ONE leading article, and never the whole title', () => {
    expect(normalizeTitle('A Game of Thrones')).toBe('game of thrones')
    expect(normalizeTitle('An Echo')).toBe('echo')
    expect(normalizeTitle('The The')).toBe('the')
    expect(normalizeTitle('The')).toBe('the')
    expect(normalizeTitle('')).toBe('')
  })

  it('does not strip other edition qualifiers', () => {
    expect(normalizeTitle('Dune Messiah')).not.toBe(normalizeTitle('Dune'))
    expect(normalizeTitle('Dune (Abridged)')).toBe('dune abridged')
  })

  it('builds an unordered author token set', () => {
    expect(authorTokens('Herbert, Frank')).toEqual(authorTokens('Frank Herbert'))
    expect(authorTokens('J.K. Rowling')).toEqual(authorTokens('J. K. Rowling'))
    expect([...authorTokens('J. R. R. Tolkien')].sort()).toEqual(['j', 'r', 'tolkien'])
    expect(authorTokens('').size).toBe(0)
  })
})

describe('findOwned', () => {
  const item = (id: string, title: string, authorName: string | null, genres?: string[]): AbsLibraryItem =>
    ({ id, libraryId: 'lib1', media: { metadata: { title, authorName, genres } } }) as AbsLibraryItem
  const dune = item('book-1', 'Dune', 'Frank Herbert', ['Science Fiction', 'Audiobook'])
  const hobbit = item('book-3', 'The Hobbit', 'J. R. R. Tolkien')

  it('matches an exact title and author confidently', () => {
    const match = findOwned(buildOwnedIndex([dune, hobbit]), 'Dune', 'Frank Herbert')
    expect(match.kind).toBe('confident')
    if (match.kind === 'confident') {
      expect(match.entry.id).toBe('book-1')
      expect(match.entry.genres).toEqual(['Science Fiction'])
    }
  })

  it('matches across article, unabridged, case, and punctuation', () => {
    const potter = item('book-2', "Harry Potter and the Philosopher's Stone", 'J. K. Rowling')
    const index = buildOwnedIndex([potter])
    expect(findOwned(index, 'HARRY POTTER AND THE PHILOSOPHERS STONE (Unabridged)', 'J.K. Rowling').kind).toBe('confident')
  })

  it('is confident across author initials and name order', () => {
    const index = buildOwnedIndex([dune, hobbit])
    expect(findOwned(index, 'Hobbit', 'Tolkien').kind).toBe('confident')
    expect(findOwned(index, 'The Hobbit (Unabridged)', 'J.R.R. Tolkien').kind).toBe('confident')
    expect(findOwned(index, 'Dune', 'Herbert, Frank').kind).toBe('confident')
  })

  it('returns none for an unknown or blank title', () => {
    const index = buildOwnedIndex([dune])
    expect(findOwned(index, 'Dune Messiah', 'Frank Herbert')).toEqual({ kind: 'none' })
    expect(findOwned(index, '', '')).toEqual({ kind: 'none' })
    expect(findOwned(index, '   ', 'Frank Herbert')).toEqual({ kind: 'none' })
  })

  it('is ambiguous, never confident, when the searched author is blank', () => {
    const match = findOwned(buildOwnedIndex([dune]), 'Dune', '')
    expect(match.kind).toBe('ambiguous')
    if (match.kind === 'ambiguous') expect(match.entries.map((entry) => entry.id)).toEqual(['book-1'])
  })

  it('is ambiguous when the library book has no author', () => {
    expect(findOwned(buildOwnedIndex([item('book-4', 'Dune', null)]), 'Dune', 'Frank Herbert').kind).toBe('ambiguous')
    expect(findOwned(buildOwnedIndex([item('book-4', 'Dune', '')]), 'Dune', '').kind).toBe('ambiguous')
  })

  it('is ambiguous when the authors disagree', () => {
    expect(findOwned(buildOwnedIndex([dune]), 'Dune', 'Brian Herbert').kind).toBe('ambiguous')
  })

  it('is confident when several books share the title but exactly one author agrees', () => {
    const index = buildOwnedIndex([item('book-9', 'Dune', 'Somebody Else'), dune, item('book-8', 'Dune', 'Brian Herbert')])
    const match = findOwned(index, 'Dune', 'Frank Herbert')
    expect(match.kind).toBe('confident')
    if (match.kind === 'confident') expect(match.entry.id).toBe('book-1')
  })

  it('is ambiguous when two same-title books both have an agreeing author, listing just those two', () => {
    const index = buildOwnedIndex([dune, item('book-10', 'Dune', 'Frank Herbert'), item('book-9', 'Dune', 'Somebody Else')])
    const match = findOwned(index, 'Dune', 'Frank Herbert')
    expect(match.kind).toBe('ambiguous')
    if (match.kind === 'ambiguous') expect(match.entries.map((entry) => entry.id)).toEqual(['book-1', 'book-10'])
  })

  it('is ambiguous, listing every title match, when same-title books exist but no author agrees', () => {
    const index = buildOwnedIndex([dune, item('book-9', 'Dune', 'Somebody Else')])
    const match = findOwned(index, 'Dune', 'Nobody Known')
    expect(match.kind).toBe('ambiguous')
    if (match.kind === 'ambiguous') expect(match.entries.map((entry) => entry.id)).toEqual(['book-1', 'book-9'])
  })

  it('never narrows to one book on a blank author, however many share the title', () => {
    expect(findOwned(buildOwnedIndex([dune, item('book-9', 'Dune', '')]), 'Dune', '').kind).toBe('ambiguous')
    expect(findOwned(buildOwnedIndex([dune, item('book-9', 'Dune', 'Somebody Else')]), 'Dune', '').kind).toBe('ambiguous')
  })

  it('skips library books with a blank title and tolerates missing genres', () => {
    const index = buildOwnedIndex([item('x', '', 'Nobody'), item('y', 'Emma', 'Jane Austen')])
    expect(index.size).toBe(1)
    const match = findOwned(index, 'Emma', 'Austen')
    expect(match.kind === 'confident' && match.entry.genres).toEqual([])
  })
})

describe('topGenres', () => {
  const DAY = 86_400_000
  const HOUR = 3600
  const HALF_LIFE_MS = FOR_YOU.RECENCY_HALF_LIFE_DAYS * DAY

  const book = (id: string, lastUpdate: number, overrides: Partial<ListenedBook> = {}): ListenedBook => ({
    id,
    title: `Title ${id}`,
    author: `Author ${id}`,
    genres: [],
    currentTimeSec: 0,
    durationSec: 0,
    isFinished: false,
    lastUpdate,
    ...overrides
  })

  it('returns [] for empty history, and never invents a genre', () => {
    expect(topGenres([], 0)).toEqual([])
    expect(topGenres([], undefined, 3)).toEqual([])
    expect(topGenres([book('b1', 1), book('b2', 2)], 2)).toEqual([])
  })

  it('returns [] when nothing is past the gate', () => {
    const recent = [
      book('a', 2, { genres: ['Memoir'], currentTimeSec: 300, durationSec: 36_000 }),
      book('b', 1, { genres: ['Memoir'], currentTimeSec: 600, durationSec: 36_000 })
    ]
    expect(topGenres(recent, 2)).toEqual([])
  })

  it('gates an unfinished book at exactly 1800 seconds', () => {
    const at = (currentTimeSec: number) => book('g', 1, { genres: ['Fantasy'], currentTimeSec, durationSec: 36_000 })
    expect(FOR_YOU.MIN_LISTEN_SECONDS).toBe(1800)
    expect(passesGate(at(1799))).toBe(false)
    expect(passesGate(at(1800))).toBe(true)
    expect(passesGate(book('u', 1, { genres: ['Fantasy'], durationSec: 36_000 }))).toBe(false)
    expect(topGenres([at(1799)], 1)).toEqual([])
    expect(topGenres([at(1800)], 1)).toEqual(['Fantasy'])
  })

  it('lets a finished book through the gate regardless of position', () => {
    expect(passesGate(book('f', 1, { isFinished: true, durationSec: 36_000 }))).toBe(true)
  })

  it('weighs a finished book 1.5x an unfinished one at the same time, and caps hours at 15', () => {
    const unfinished = book('u', 5, { currentTimeSec: HOUR, durationSec: 10 * HOUR })
    const finished = book('f', 5, { isFinished: true, currentTimeSec: HOUR, durationSec: HOUR })
    const marathon = book('m', 5, { currentTimeSec: 100 * HOUR, durationSec: 200 * HOUR })
    expect(bookWeight(finished, 5)).toBeCloseTo(bookWeight(unfinished, 5) * FOR_YOU.FINISHED_BONUS, 9)
    expect(bookWeight(marathon, 5)).toBeCloseTo(FOR_YOU.MAX_BOOK_HOURS, 9)
  })

  it('uses max(duration, position) as the listened time of a finished book', () => {
    expect(bookWeight(book('f', 5, { isFinished: true, currentTimeSec: 0, durationSec: 4 * HOUR }), 5)).toBeCloseTo(4 * FOR_YOU.FINISHED_BONUS, 9)
  })

  it('halves a book weight every 90 days, so a recent light book outranks an old heavy one', () => {
    const now = 1_000 * DAY
    const fresh = book('now', now, { currentTimeSec: 4 * HOUR, durationSec: 10 * HOUR })
    const older = book('older', now - HALF_LIFE_MS, { currentTimeSec: 4 * HOUR, durationSec: 10 * HOUR })
    const twice = book('twice', now - 2 * HALF_LIFE_MS, { currentTimeSec: 4 * HOUR, durationSec: 10 * HOUR })
    expect(bookWeight(older, now)).toBeCloseTo(bookWeight(fresh, now) / 2, 9)
    expect(bookWeight(twice, now)).toBeCloseTo(bookWeight(fresh, now) / 4, 9)

    const heavyButOld = book('old', now - 2 * HALF_LIFE_MS, { genres: ['Old'], currentTimeSec: 10 * HOUR, durationSec: 20 * HOUR })
    const lightButNew = book('new', now, { genres: ['New'], currentTimeSec: 6 * HOUR, durationSec: 20 * HOUR })
    expect(topGenres([heavyButOld, lightButNew], now)).toEqual(['New', 'Old'])
  })

  it('treats a lastUpdate in the future as age 0', () => {
    const future = book('f', 2_000, { currentTimeSec: 2 * HOUR, durationSec: 10 * HOUR })
    expect(bookWeight(future, 1_000)).toBeCloseTo(2, 9)
  })

  it('measures age from `now`, which changes weights but not the ranking', () => {
    const recent = [
      book('a', 100 * DAY, { genres: ['Alpha'], currentTimeSec: 5 * HOUR, durationSec: 10 * HOUR }),
      book('b', 40 * DAY, { genres: ['Beta'], currentTimeSec: 6 * HOUR, durationSec: 10 * HOUR })
    ]
    expect(topGenres(recent, 100 * DAY)).toEqual(topGenres(recent, 900 * DAY))
  })

  it('drops a genre below 10% of the top genre but always keeps the top', () => {
    const tiny = book('tiny', 9, { genres: ['Tiny'], currentTimeSec: FOR_YOU.MIN_LISTEN_SECONDS, durationSec: 20 * HOUR })
    const recent = [
      book('top', 9, { genres: ['Top'], currentTimeSec: 15 * HOUR, durationSec: 20 * HOUR }),
      book('mid', 9, { genres: ['Mid'], currentTimeSec: 3 * HOUR, durationSec: 20 * HOUR }),
      tiny
    ]
    expect(topGenres(recent, 9)).toEqual(['Top', 'Mid'])
    expect(topGenres([tiny], 9)).toEqual(['Tiny'])
  })

  it('caps the result at 3 genres by default and honours an explicit count', () => {
    const recent = ['A', 'B', 'C', 'D', 'E'].map((genre, index) => book(genre, 10, { genres: [genre], currentTimeSec: (10 - index) * HOUR, durationSec: 20 * HOUR }))
    expect(FOR_YOU.TOP_GENRE_COUNT).toBe(3)
    expect(topGenres(recent, 10)).toEqual(['A', 'B', 'C'])
    expect(topGenres(recent, 10, 1)).toEqual(['A'])
    expect(topGenres(recent, 10, 5)).toEqual(['A', 'B', 'C', 'D', 'E'])
    expect(topGenres(recent, 10, 0)).toEqual([])
  })

  it('lets heavy listening outweigh several light books', () => {
    const recent = [
      book('heavy', 3, { genres: ['Epic'], currentTimeSec: 30 * HOUR, durationSec: 60 * HOUR }),
      book('l1', 3, { genres: ['Light1'], currentTimeSec: 2_400, durationSec: 36_000 }),
      book('l2', 3, { genres: ['Light2'], currentTimeSec: 2_400, durationSec: 36_000 })
    ]
    expect(topGenres(recent, 3, 1)).toEqual(['Epic'])
  })

  it('a barely listened memoir never beats finished books (Kotlin vector)', () => {
    const newest = 100 * DAY
    const memoir = (id: string, lastUpdate: number) => book(id, lastUpdate, { genres: ['Memoir'], currentTimeSec: 300, durationSec: 36_000 })
    const finished = (id: string, lastUpdate: number, genre: string) => book(id, lastUpdate, { genres: [genre], isFinished: true, currentTimeSec: 40_000, durationSec: 40_000 })
    const recent = [memoir('m1', newest), memoir('m2', newest - 1), finished('f', newest - DAY, 'Fantasy'), finished('my', newest - 2 * DAY, 'Mystery'), finished('th', newest - 3 * DAY, 'Thriller')]
    expect(topGenres(recent, newest)).toEqual(['Fantasy', 'Mystery', 'Thriller'])
  })

  it('counts a book once per genre key and merges spellings across books (Kotlin vector)', () => {
    const recent = [
      book('b1', 30, { genres: ['Fantasy', 'fantasy ', 'Adventure'], currentTimeSec: 2 * HOUR, durationSec: 10 * HOUR }),
      book('b2', 20, { genres: ['fantasy'], currentTimeSec: 2 * HOUR, durationSec: 10 * HOUR }),
      book('b3', 10, { genres: ['Mystery'], currentTimeSec: 5 * HOUR, durationSec: 10 * HOUR })
    ]
    // Fantasy = b1 + b2 = 4h (b1 once, not twice) < Mystery 5h; the first spelling wins.
    expect(topGenres(recent, 30)).toEqual(['Mystery', 'Fantasy', 'Adventure'])
  })

  it('gives an unknown-time book a neutral 1h weight, and finished still gets the bonus (Kotlin vector)', () => {
    const unfinished = book('u', 7, { genres: ['Reading'] })
    const finished = book('f', 7, { genres: ['Done'], isFinished: true })
    expect(bookWeight(unfinished, 7)).toBeCloseTo(FOR_YOU.UNKNOWN_BOOK_HOURS, 9)
    expect(bookWeight(finished, 7)).toBeCloseTo(FOR_YOU.UNKNOWN_BOOK_HOURS * FOR_YOU.FINISHED_BONUS, 9)
    expect(topGenres([unfinished, finished], 7)).toEqual(['Done', 'Reading'])
  })

  it('only tallies the newest 40 books (Kotlin vector)', () => {
    const n = FOR_YOU.RECENT_BOOKS_LIMIT
    const recent = [
      ...Array.from({ length: n }, (_, i) => book(`new${i + 1}`, 1_000 + i + 1, { genres: ['Recent'], currentTimeSec: HOUR, durationSec: 10 * HOUR })),
      ...Array.from({ length: n }, (_, i) => book(`old${i + 1}`, i + 1, { genres: ['Ancient'], currentTimeSec: 10 * HOUR, durationSec: 20 * HOUR }))
    ]
    expect(topGenres(recent, 1_000 + n)).toEqual(['Recent'])
  })

  it('ignores noise genres and folds scifi before counting', () => {
    const recent = [
      book('a', 3, { genres: ['Audiobook', 'Audiobooks'], currentTimeSec: 20 * HOUR, durationSec: 30 * HOUR }),
      book('b', 3, { genres: ['SciFi'], currentTimeSec: 2 * HOUR, durationSec: 10 * HOUR }),
      book('c', 3, { genres: ['Science Fiction, Space Opera'], currentTimeSec: 2 * HOUR, durationSec: 10 * HOUR }),
      book('d', 3, { genres: ['Fantasy'], currentTimeSec: 3 * HOUR, durationSec: 10 * HOUR })
    ]
    // SciFi + Science Fiction = 4h beats Fantasy 3h only if the two spellings were merged.
    expect(topGenres(recent, 3)).toEqual(['Science Fiction', 'Fantasy', 'Space Opera'])
    expect(topGenres([recent[0]!], 3)).toEqual([])
  })

  it('breaks exact ties by first seen in newest-first order, whatever the input order', () => {
    // Equal weight needs equal age, i.e. an equal lastUpdate; the sort is stable on ties, so the
    // input order is what decides between two books and the genre order inside one book.
    const a = book('a', 5, { genres: ['Beta', 'Alpha'], currentTimeSec: 2 * HOUR, durationSec: 10 * HOUR })
    expect(topGenres([a], 5)).toEqual(['Beta', 'Alpha'])
    const x = book('x', 5, { genres: ['X'], currentTimeSec: 2 * HOUR, durationSec: 10 * HOUR })
    const y = book('y', 5, { genres: ['Y'], currentTimeSec: 2 * HOUR, durationSec: 10 * HOUR })
    expect(topGenres([x, y], 5)).toEqual(['X', 'Y'])
    expect(topGenres([y, x], 5)).toEqual(['Y', 'X'])
  })

  it('prefers the more recently listened book when the weights are otherwise level', () => {
    const now = 10 * DAY
    // Same hours; the newer book decays less, so its genre outranks the older one regardless of
    // input order.
    const newer = book('newer', now, { genres: ['Newer'], currentTimeSec: 2 * HOUR, durationSec: 10 * HOUR })
    const older = book('older', now - DAY, { genres: ['Older'], currentTimeSec: 2 * HOUR, durationSec: 10 * HOUR })
    expect(topGenres([older, newer], now)).toEqual(['Newer', 'Older'])
    expect(topGenres([newer, older], now)).toEqual(['Newer', 'Older'])
  })
})

describe('mergeCards', () => {
  const card = (key: string, title = `Title ${key}`, author = `Author ${key}`): DiscoverItem => ({ key, title, author, coverUrl: null, year: null, popularity: null })
  const keys = (cards: DiscoverItem[]) => cards.map((entry) => entry.key)

  it('appends new cards after the existing ones, in order', () => {
    expect(keys(mergeCards([card('A'), card('B')], [card('C'), card('D')]))).toEqual(['A', 'B', 'C', 'D'])
    expect(mergeCards([], [])).toEqual([])
    expect(keys(mergeCards([], [card('A')]))).toEqual(['A'])
  })

  it('drops a cross-page duplicate by key (Kotlin vector)', () => {
    expect(keys(mergeCards([card('A'), card('B')], [card('B'), card('C')]))).toEqual(['A', 'B', 'C'])
  })

  it('shows a key repeated within one page once (Kotlin vector)', () => {
    expect(keys(mergeCards([], [card('A'), card('A'), card('B')]))).toEqual(['A', 'B'])
  })

  it('keeps the existing copy of a duplicate, not the incoming one', () => {
    const existing = card('A', 'Original', 'Someone')
    const merged = mergeCards([existing], [card('A', 'Replacement', 'Someone')])
    expect(merged).toEqual([existing])
    expect(merged[0]).toBe(existing)
  })

  it('treats two different keys as two works even when title and author match', () => {
    const merged = mergeCards([card('/works/OL1W', 'Dune', 'Frank Herbert')], [card('/works/OL2W', 'Dune!', 'Herbert, Frank')])
    expect(keys(merged)).toEqual(['/works/OL1W', '/works/OL2W'])
  })

  it('does not cap the merged list (Kotlin vector)', () => {
    const first = Array.from({ length: 20 }, (_, i) => card(`A${i}`))
    const second = Array.from({ length: 20 }, (_, i) => card(`B${i}`))
    expect(mergeCards(first, second)).toHaveLength(40)
  })

  it('falls back to title plus author tokens only for a keyless card (Kotlin vector, adapted)', () => {
    const existing = [card('/works/OLAW', 'Dune', 'Frank Herbert')]
    const keyless = card('', 'The Dune', 'Herbert, Frank')
    const keylessOther = card('', 'Emma', 'Jane Austen')
    expect(keys(mergeCards(existing, [keyless, keylessOther]))).toEqual(['/works/OLAW', ''])
    expect(mergeCards(existing, [keyless, keylessOther])[1]).toBe(keylessOther)
  })

  it('dedupes keyless cards against each other', () => {
    const merged = mergeCards([], [card('', 'Dune', 'Frank Herbert'), card('  ', 'Dune (Unabridged)', 'Herbert Frank')])
    expect(merged).toHaveLength(1)
  })

  it('keeps a keyless card with a different author, and one with no usable title', () => {
    expect(mergeCards([card('/works/OLAW', 'Dune', 'Frank Herbert')], [card('', 'Dune', 'Brian Herbert')])).toHaveLength(2)
    expect(mergeCards([], [card('', '', 'x'), card('', '', 'x')])).toHaveLength(2)
  })

  it('does not mutate its inputs', () => {
    const existing = [card('A')]
    const incoming = [card('A'), card('B')]
    mergeCards(existing, incoming)
    expect(existing).toHaveLength(1)
    expect(incoming).toHaveLength(2)
  })
})
