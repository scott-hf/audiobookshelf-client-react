/**
 * Pure logic behind the Discover browse screen: URL state, genre cleaning, owned-book matching,
 * the "For you" genre-affinity ranking, and cross-page card dedupe.
 *
 * No React, no network, no imports from `hooks/` or `components/`. This is a port of the Kotlin
 * ShelfDroid acquisition code (`CatalogBookMatcher`, `DiscoverShelfPlanner`,
 * `DiscoverBrowseReducer`, `DiscoverViewModel.selectGenre`) so the restored behaviour matches the
 * app it comes from, with the deliberate deviations called out where they occur:
 *   - an owned-book match with a blank/disagreeing author is `ambiguous`, never `confident`;
 *   - dedupe is by Open Library key first, and two different keys are never merged on title;
 *   - genres are cleaned (comma split, noise dropped, `scifi` folded) before they are counted.
 */
import type { DiscoverItem, DiscoverOption, DiscoverOptionsResponse } from '@abs/acquisition-contract'
import type { AbsLibraryItem } from '../types/abs'

/* ------------------------------------------------------------------------------------------ */
/* URL state                                                                                   */
/* ------------------------------------------------------------------------------------------ */

/** Client-only "For you" tab id. A server catalog with this id is dropped ({@link browseCatalogs}). */
export const FOR_YOU_ID = 'for_you'
/** Client-only "all genres" sentinel. NEVER sent upstream: it means "no genre", i.e. omit `genre`. */
export const GENRE_ALL_ID = '__all__'
/** The catalog a genre picked on For you opens, when the server lists it. */
export const POPULAR_CATALOG_ID = 'popular'

export type DiscoverMode = 'browse' | 'search'

export type BrowseSelection =
  | { kind: 'forYou' }
  | { kind: 'catalog'; catalogId: string; genreId: string | null; genreLabel: string | null }

export interface DiscoverQuery {
  mode: DiscoverMode
  selection: BrowseSelection
  /** The acquisition search text. Kept independent of `mode` so switching tabs does not lose it. */
  q: string
}

/**
 * Default mode is `search`, not `browse`: `/library/:id/discover` already opened the acquisition
 * search field before browse existed, and the existing route tests (and users' muscle memory)
 * depend on that. Browse is opt-in through `?mode=browse`.
 *
 * The default browse selection is Popular, not For you: Popular is what the restored screen shows
 * selected, and `popular` is a pinned Librarr catalog id (not server-dependent), so it is safe even
 * before the options load. For you is by far the most expensive view (it needs the whole library
 * index and the user's progress, then one upstream call per genre), so it is reachable only when
 * the URL asks for it explicitly with `catalog=for_you`.
 */
export const DEFAULT_DISCOVER_QUERY: DiscoverQuery = {
  mode: 'search',
  selection: { kind: 'catalog', catalogId: POPULAR_CATALOG_ID, genreId: null, genreLabel: null },
  q: ''
}

/**
 * The server catalogs a browse request may name: everything Librarr listed except an entry that
 * collides with the client-only {@link FOR_YOU_ID}. Empty while the options are not loaded.
 */
export function browseCatalogs(options: DiscoverOptionsResponse | null): DiscoverOption[] {
  return options ? options.catalogs.filter((catalog) => catalog.id !== FOR_YOU_ID) : []
}

/** `null` for a blank value or the {@link GENRE_ALL_ID} sentinel: neither may reach the server. */
function realGenreId(raw: string | null | undefined): string | null {
  const id = raw?.trim() ?? ''
  return id === '' || id === GENRE_ALL_ID ? null : id
}

function cleanLabel(raw: string | null | undefined): string | null {
  const label = raw?.trim() ?? ''
  return label === '' ? null : label
}

/**
 * Query params (all optional; absent == default, as in `libraryQuery`):
 *   mode        `browse`; absent means `search`
 *   catalog     a server catalog id, or `for_you`; absent means Popular
 *   genre       a genre id (an options genre id, or a cleaned library genre -- Librarr normalises it)
 *   genreLabel  display name for `genre`, so the chip can name it before the options load
 *   q           the acquisition search text
 *
 * `options` is the loaded `/discover/options` response, or `null` while it loads. `catalog=for_you`
 * is the only way to reach For you, and it needs no options. An unknown `catalog` falls back to
 * the default (Popular, no genre) rather than being sent upstream, and so does any catalog other
 * than `popular` while `options` is `null` (it cannot be verified yet): re-parse once the options
 * arrive. `popular` is pinned, so it is accepted without options. `genre` is not validated against
 * the options, because a cleaned library genre is a legitimate `genre` value; only the all-genres
 * sentinel and blanks are rejected.
 */
export function parseDiscoverQuery(params: URLSearchParams, options: DiscoverOptionsResponse | null): DiscoverQuery {
  const mode: DiscoverMode = params.get('mode') === 'browse' ? 'browse' : 'search'
  const rawQ = params.get('q') ?? ''
  const q = rawQ.trim() === '' ? '' : rawQ

  const rawCatalog = params.get('catalog')?.trim() ?? ''
  if (rawCatalog === FOR_YOU_ID) return { mode, selection: { kind: 'forYou' }, q }

  // Absent means Popular; a present id must be Popular (pinned) or listed by the server.
  const known = rawCatalog === '' || rawCatalog === POPULAR_CATALOG_ID || browseCatalogs(options).some((catalog) => catalog.id === rawCatalog)
  if (!known) return { mode, selection: DEFAULT_DISCOVER_QUERY.selection, q }
  const catalogId = rawCatalog === '' ? POPULAR_CATALOG_ID : rawCatalog
  const genreId = realGenreId(params.get('genre'))
  const label = genreId === null ? null : (cleanLabel(params.get('genreLabel')) ?? options?.genres.find((genre) => genre.id === genreId)?.label ?? null)
  return { mode, selection: { kind: 'catalog', catalogId, genreId, genreLabel: label }, q }
}

export function toDiscoverSearchParams(query: DiscoverQuery): URLSearchParams {
  const params = new URLSearchParams()
  if (query.mode !== 'search') params.set('mode', query.mode)
  const { selection } = query
  // Popular is the default catalog, so it writes no `catalog`. For you is written explicitly as
  // `catalog=for_you` (a client-only URL token, never a request param). A server catalog carrying
  // the For you id is malformed and writes nothing, rather than masquerade as the For you tab.
  if (selection.kind === 'forYou') params.set('catalog', FOR_YOU_ID)
  else if (selection.catalogId.trim() !== '' && selection.catalogId !== FOR_YOU_ID) {
    if (selection.catalogId !== POPULAR_CATALOG_ID) params.set('catalog', selection.catalogId)
    const genreId = realGenreId(selection.genreId)
    if (genreId !== null) {
      params.set('genre', genreId)
      const label = cleanLabel(selection.genreLabel)
      if (label !== null) params.set('genreLabel', label)
    }
  }
  if (query.q.trim() !== '') params.set('q', query.q)
  return params
}

/**
 * The selection after the user picks a genre chip (`null` or {@link GENRE_ALL_ID} = "all genres").
 *
 * On a catalog it just sets the genre. On For you a genre LEAVES For you and opens the first real
 * catalog (preferring `popular`) in that genre -- `DiscoverViewModel.selectGenre`. Picking "all
 * genres" on For you changes nothing, and neither does a genre when the server lists no catalog.
 */
export function nextSelectionOnGenre(current: BrowseSelection, genreId: string | null, genreLabel: string | null, options: DiscoverOptionsResponse): BrowseSelection {
  const genre = realGenreId(genreId)
  const label = genre === null ? null : cleanLabel(genreLabel)
  if (current.kind === 'catalog') return { ...current, genreId: genre, genreLabel: label }
  if (genre === null) return current
  const catalogs = browseCatalogs(options)
  const catalog = catalogs.find((entry) => entry.id === POPULAR_CATALOG_ID) ?? catalogs[0]
  if (!catalog) return current
  return { kind: 'catalog', catalogId: catalog.id, genreId: genre, genreLabel: label }
}

/* ------------------------------------------------------------------------------------------ */
/* Genre cleaning                                                                              */
/* ------------------------------------------------------------------------------------------ */

/**
 * Genre strings that carry no information, as normalised by {@link normalizeGenre}. Every entry
 * was measured in the real library (105 items), where the genre field is mostly noise: 26x
 * "Audiobook", 26x "Audiobooks", 3x "Books & Spoken", and one each of "Speech", "Other" and
 * "Two Hours or More (65-100 Pages)" (an Audible length bucket, not a genre). Extend this list
 * when a new junk value shows up; it is the only place that decides what is noise.
 *
 * Deliberately NOT here although they look generic: "Literature & Fiction" and "Action &
 * Adventure" (Audible top-level categories) -- they are weak but real, so they are kept.
 */
export const NOISE_GENRES: ReadonlySet<string> = new Set([
  'audiobook',
  'audiobooks',
  'books & spoken',
  'speech',
  'other',
  'two hours or more (65-100 pages)'
])

/**
 * Spelling variants folded into one genre, normalised alias -> display name. `SciFi` is in the real
 * library next to 24x "Science Fiction", and left alone it would split the one real signal in two.
 * Only true spelling variants belong here: "Space Opera" and "Hard Science Fiction" are genuine
 * subgenres and stay distinct.
 */
export const GENRE_ALIASES: ReadonlyMap<string, string> = new Map([
  ['scifi', 'Science Fiction'],
  ['sci-fi', 'Science Fiction'],
  ['sci fi', 'Science Fiction']
])

/** Lowercase, trimmed, whitespace collapsed: the comparison form of a genre. */
export function normalizeGenre(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Real genres from a raw genre list: entries are split on commas AND on a spaced slash (" / "),
 * noise dropped, spelling variants folded, duplicates removed. Both occur as ONE string in the
 * real data: "Adventure, Space Opera, Military" and "Fiction / Science Fiction & Fantasy / Hard
 * Science Fiction" (an Audible category path, which is useless as a single upstream `genre`).
 * An unspaced slash ("Sci/Fi") is not a separator and is left alone.
 *
 * Returns display strings: the raw spelling (whitespace-collapsed) of the first occurrence, except
 * that a folded alias is shown as its canonical name ("SciFi" -> "Science Fiction"), since these
 * strings are shown to the user and sent upstream as `genre`. Tolerates `undefined`, `null` and
 * `[]` (17 of 105 real items have no genres).
 */
export function cleanGenres(raw: readonly string[] | null | undefined): string[] {
  const seen = new Set<string>()
  const genres: string[] = []
  for (const entry of raw ?? []) {
    if (typeof entry !== 'string') continue
    for (const piece of entry.split(/,|\s+\/\s+/)) {
      const normalized = normalizeGenre(piece)
      if (normalized === '' || NOISE_GENRES.has(normalized)) continue
      const display = GENRE_ALIASES.get(normalized) ?? piece.trim().replace(/\s+/g, ' ')
      const key = normalizeGenre(display)
      if (seen.has(key)) continue
      seen.add(key)
      genres.push(display)
    }
  }
  return genres
}

/* ------------------------------------------------------------------------------------------ */
/* Owned-book matching                                                                         */
/* ------------------------------------------------------------------------------------------ */

export interface OwnedIndexEntry {
  id: string
  title: string
  author: string
  /** Already passed through {@link cleanGenres}. */
  genres: string[]
}

/** Library books grouped by {@link normalizeTitle}. Build it once per library, not per card. */
export type OwnedIndex = Map<string, OwnedIndexEntry[]>

/**
 * Whether a discover card is a book the user already owns.
 *
 * SAFETY: a caller may open (navigate to) a library book ONLY on `confident`. `ambiguous` means a
 * title matched but identity is not established -- show "may be in your library" or nothing, never
 * a link. This deliberately differs from the Kotlin `CatalogBookMatcher`, which let a blank author
 * pass and so could open the wrong book on a title collision.
 */
export type OwnedMatch =
  | { kind: 'none' }
  /** Of the books with this title, exactly one has an author that genuinely agrees (other books
   * sharing the title do not matter: we are sure which one it is). */
  | { kind: 'confident'; entry: OwnedIndexEntry }
  /** The title matched but identity is not established: the author is blank or agrees with none of
   * the title matches (`entries` is all of them), or agrees with two or more (`entries` is just
   * those). */
  | { kind: 'ambiguous'; entries: OwnedIndexEntry[] }

function tokenize(raw: string): string[] {
  return raw
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((token) => token !== '')
}

/**
 * Lowercases, drops apostrophes, turns every other non-alphanumeric into a space, drops the word
 * "unabridged" and ONE leading `the`/`a`/`an` (never the whole title), and collapses whitespace.
 * "The Hobbit (Unabridged)" and "Hobbit" both give `hobbit`. There is deliberately no edit-distance
 * threshold.
 */
export function normalizeTitle(raw: string): string {
  const tokens = tokenize(raw).filter((token) => token !== 'unabridged')
  const first = tokens[0]
  const withoutArticle = tokens.length > 1 && first !== undefined && (first === 'the' || first === 'a' || first === 'an') ? tokens.slice(1) : tokens
  return withoutArticle.join(' ')
}

/** Author names as an unordered token set, so "Herbert, Frank" and "Frank Herbert" agree. */
export function authorTokens(raw: string): Set<string> {
  return new Set(tokenize(raw))
}

/**
 * Genuine author agreement: both sides name someone, and one side's tokens contain the other's
 * ("Tolkien" within "J. R. R. Tolkien"). A blank author is NOT agreement, and neither is a
 * partial overlap ("Brian Herbert" vs "Frank Herbert").
 */
function authorsAgree(left: string, right: string): boolean {
  const a = authorTokens(left)
  const b = authorTokens(right)
  if (a.size === 0 || b.size === 0) return false
  const contains = (outer: Set<string>, inner: Set<string>): boolean => [...inner].every((token) => outer.has(token))
  return contains(a, b) || contains(b, a)
}

export function buildOwnedIndex(items: readonly AbsLibraryItem[]): OwnedIndex {
  const index: OwnedIndex = new Map()
  for (const item of items) {
    const metadata = item.media.metadata
    const key = normalizeTitle(metadata.title ?? '')
    if (key === '') continue
    const entry: OwnedIndexEntry = { id: item.id, title: metadata.title, author: metadata.authorName ?? '', genres: cleanGenres(metadata.genres) }
    const bucket = index.get(key)
    if (bucket) bucket.push(entry)
    else index.set(key, [entry])
  }
  return index
}

export function findOwned(index: OwnedIndex, title: string, author: string): OwnedMatch {
  const key = normalizeTitle(title)
  if (key === '') return { kind: 'none' }
  const entries = index.get(key)
  if (!entries || entries.length === 0) return { kind: 'none' }
  // Narrow the title matches to those whose author genuinely agrees; a blank author agrees with
  // nobody, so it can never narrow to one book.
  const agreeing = entries.filter((entry) => authorsAgree(author, entry.author))
  const only = agreeing[0]
  if (agreeing.length === 1 && only) return { kind: 'confident', entry: only }
  return { kind: 'ambiguous', entries: agreeing.length > 1 ? agreeing : [...entries] }
}

/* ------------------------------------------------------------------------------------------ */
/* "For you" genre ranking                                                                     */
/* ------------------------------------------------------------------------------------------ */

export interface ListenedBook {
  id: string
  title: string
  author: string
  genres: string[]
  currentTimeSec: number
  durationSec: number
  isFinished: boolean
  /** Epoch MILLISECONDS (measured: 13 digits), not seconds. */
  lastUpdate: number
}

/** The Kotlin `DiscoverShelfPlanner` constants, unchanged. */
export const FOR_YOU = {
  /** Genres a For you list asks for at most. */
  TOP_GENRE_COUNT: 3,
  /** Engagement gate: an unfinished book counts only once this much has been listened (seconds). */
  MIN_LISTEN_SECONDS: 1800,
  /** A finished book weighs this much more than an unfinished one with the same listened time. */
  FINISHED_BONUS: 1.5,
  /** One book never contributes more than this many hours, so a single marathon cannot dominate. */
  MAX_BOOK_HOURS: 15,
  /** A book's weight halves for every this many days between its last update and `now`. */
  RECENCY_HALF_LIFE_DAYS: 90,
  /** A genre needs this fraction of the top genre's weight to be returned (the top always stays). */
  GENRE_FLOOR: 0.1,
  /** Only the newest this-many books are tallied. */
  RECENT_BOOKS_LIMIT: 40,
  /** Hours assumed for a book whose duration and position are both unknown. */
  UNKNOWN_BOOK_HOURS: 1
} as const

const SECONDS_PER_HOUR = 3600
const MS_PER_DAY = 86_400_000

function isTimeUnknown(book: ListenedBook): boolean {
  return book.durationSec <= 0 && book.currentTimeSec <= 0
}

/**
 * Whether the listener really listened to `book`: finished, or at least
 * {@link FOR_YOU}.MIN_LISTEN_SECONDS listened. A book whose time is unknown (duration and position
 * both not above 0) passes, so history that carries only progress keeps working; an unfinished
 * book with a known duration and nothing listened fails.
 */
export function passesGate(book: ListenedBook): boolean {
  return book.isFinished || isTimeUnknown(book) || book.currentTimeSec >= FOR_YOU.MIN_LISTEN_SECONDS
}

/**
 * How much `book` counts towards its genres: hours listened (capped), times the finished bonus,
 * times a recency decay that halves every 90 days between `lastUpdate` and `now`. 0 when the book
 * fails the gate. Listened time is a proxy (`max(duration, position)` when finished, position
 * otherwise); a book marked finished without being listened to is over-counted. A `lastUpdate`
 * after `now` (clock skew) is treated as age 0.
 */
export function bookWeight(book: ListenedBook, now: number): number {
  if (!passesGate(book)) return 0
  const hours = isTimeUnknown(book)
    ? FOR_YOU.UNKNOWN_BOOK_HOURS
    : book.isFinished
      ? Math.max(book.durationSec, book.currentTimeSec) / SECONDS_PER_HOUR
      : book.currentTimeSec / SECONDS_PER_HOUR
  const bonus = book.isFinished ? FOR_YOU.FINISHED_BONUS : 1
  const ageDays = Math.max(0, (now - book.lastUpdate) / MS_PER_DAY)
  const decay = Math.pow(0.5, ageDays / FOR_YOU.RECENCY_HALF_LIFE_DAYS)
  return Math.min(hours, FOR_YOU.MAX_BOOK_HOURS) * bonus * decay
}

/**
 * The top `count` genres of the listener's newest books, by listening weight.
 *
 * THIS IS A GENRE-AFFINITY HEURISTIC, NOT A RECOMMENDER. It counts how much of the user's recent
 * listening carried each genre tag and returns the biggest; it knows nothing about what is good,
 * what is similar, or what the user has not heard.
 *
 * It does less than it looks like on the real library. Measured on 103 listened-to books, 52 are
 * tagged only "Audiobook"/"Audiobooks" (pure noise, dropped by {@link cleanGenres}), and the one
 * real signal is "Science Fiction" (24 books). The ranking therefore collapses to roughly ONE
 * genre; the floor, the top-3 cap and the tie-break rarely have anything to decide. A future
 * reader should not mistake the machinery for a rich taste model, and should expect For you to be
 * mostly "popular Science Fiction" until the library's tagging improves.
 *
 * Rules (the Kotlin `DiscoverShelfPlanner`, unchanged): only the newest RECENT_BOOKS_LIMIT books
 * count; each book adds its {@link bookWeight} to every genre it carries, once per genre; books
 * failing the 1800 s engagement gate weigh nothing; genres below 10% of the top genre's weight are
 * dropped (the top always stays); exact ties go to the genre seen first in newest-first order.
 * Genres go through {@link cleanGenres} first.
 *
 * `now` (epoch ms, default the real clock) is a parameter so the decay is testable. Measuring age
 * from `now` rather than from the newest book scales every weight by one common factor, so it
 * changes no ranking, floor or cut -- it only changes the absolute weights.
 *
 * Never invents a genre: no history, or no book past the gate, returns `[]`.
 */
export function topGenres(history: readonly ListenedBook[], now: number = Date.now(), count: number = FOR_YOU.TOP_GENRE_COUNT): string[] {
  const newest = [...history].sort((a, b) => b.lastUpdate - a.lastUpdate).slice(0, FOR_YOU.RECENT_BOOKS_LIMIT)

  const tally = new Map<string, { display: string; weight: number; firstSeen: number }>()
  for (const book of newest) {
    const weight = bookWeight(book, now)
    if (weight <= 0) continue
    for (const display of cleanGenres(book.genres)) {
      const key = normalizeGenre(display)
      const entry = tally.get(key)
      if (entry) entry.weight += weight
      else tally.set(key, { display, weight, firstSeen: tally.size })
    }
  }

  const ranked = [...tally.values()].sort((a, b) => b.weight - a.weight || a.firstSeen - b.firstSeen)
  const top = ranked[0]
  if (!top) return []
  const floor = top.weight * FOR_YOU.GENRE_FLOOR
  return ranked
    .filter((entry) => entry.weight >= floor)
    .slice(0, Math.max(0, count))
    .map((entry) => entry.display)
}

/* ------------------------------------------------------------------------------------------ */
/* Cross-page card dedupe                                                                      */
/* ------------------------------------------------------------------------------------------ */

/** Normalised title plus sorted author tokens; `''` when the title normalises to nothing. */
function titleKey(item: DiscoverItem): string {
  const title = normalizeTitle(item.title)
  if (title === '') return ''
  return `${title}|${[...authorTokens(item.author)].sort().join(' ')}`
}

/**
 * Appends `incoming` to `existing`, dropping duplicates; order is preserved, existing first.
 *
 * Identity is the Open Library work `key` (stable): the same key is the same work, and two
 * different keys are two different works even when title and author match -- unlike the Kotlin
 * reducer, which also merged those. Only an item with NO key (blank, which the contract forbids
 * but a defensive caller may produce) falls back to normalised title + sorted author tokens, and
 * it is then compared against every item already kept. A keyed item is never dropped on title.
 * A keyless item with an empty normalised title cannot be compared and is always kept.
 * Duplicates inside `existing` are dropped too, so the result is always safe as a React key list.
 */
export function mergeCards(existing: readonly DiscoverItem[], incoming: readonly DiscoverItem[]): DiscoverItem[] {
  const seenKeys = new Set<string>()
  const seenTitles = new Set<string>()
  const merged: DiscoverItem[] = []
  for (const item of [...existing, ...incoming]) {
    const key = item.key.trim()
    const title = titleKey(item)
    if (key !== '') {
      if (seenKeys.has(key)) continue
    } else if (title !== '' && seenTitles.has(title)) {
      continue
    }
    // A keyless card whose title normalises to nothing has no identity to compare, so (as in the
    // Kotlin reducer) it is kept rather than guessed to be a duplicate.
    if (key !== '') seenKeys.add(key)
    if (title !== '') seenTitles.add(title)
    merged.push(item)
  }
  return merged
}
