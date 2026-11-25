/**
 * Encoding for the `filter` query param of `GET /api/libraries/:id/items`.
 *
 * Wire format (confirmed against the ABS web client's `$encode`): `<group>.` followed by
 * `encodeURIComponent(base64(utf8(value)))`. The web app's `src/lib/filterUtils.ts` is the
 * origin of the codec; this copy drops the Node `Buffer` branch because the mobile app only ever
 * runs in a WebView.
 *
 * The value half is ALREADY URL-encoded, so a finished filter string is appended to the query
 * verbatim -- running it through `encodeURIComponent`/`URLSearchParams` again would double-encode
 * the `%3D` padding and the server would see `%3D` where it expects `=`.
 */

/** Filter groups the server's `/items` endpoint understands (a value follows the dot). */
export type FilterGroup = 'genres' | 'tags' | 'series' | 'authors' | 'progress' | 'narrators' | 'publishers' | 'publishedDecades' | 'languages'

export const FILTER_GROUPS: readonly FilterGroup[] = ['genres', 'tags', 'series', 'authors', 'progress', 'narrators', 'publishers', 'publishedDecades', 'languages']

/** The only values the `progress` group accepts. */
export type ProgressFilterValue = 'finished' | 'in-progress' | 'not-started' | 'not-finished'

export const PROGRESS_FILTER_VALUES: readonly ProgressFilterValue[] = ['finished', 'in-progress', 'not-started', 'not-finished']

function utf8ToBase64(text: string): string {
  // btoa only takes Latin-1, so go through UTF-8 bytes to keep non-ASCII titles/names intact.
  const bytes = new TextEncoder().encode(text)
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')
  return btoa(binary)
}

function base64ToUtf8(base64: string): string {
  const binary = atob(base64)
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/** Encodes a filter value: UTF-8 -> base64 -> URL-encode. */
export function filterEncode(text: string): string {
  return encodeURIComponent(utf8ToBase64(text))
}

/** Inverse of [filterEncode]. */
export function filterDecode(text: string): string {
  return base64ToUtf8(decodeURIComponent(text))
}

/**
 * Builds a `filter` param value for any group. Prefer the typed helpers below, which make the
 * name-vs-id distinction impossible to get wrong.
 */
export function buildFilter(group: FilterGroup, value: string): string {
  return `${group}.${filterEncode(value)}`
}

/** Genres are filtered by NAME (the string from `filterdata.genres`). */
export const genreFilter = (genre: string): string => buildFilter('genres', genre)

/** Tags are filtered by NAME (the string from `filterdata.tags`). */
export const tagFilter = (tag: string): string => buildFilter('tags', tag)

/** Narrators are filtered by NAME. */
export const narratorFilter = (narrator: string): string => buildFilter('narrators', narrator)

export const publisherFilter = (publisher: string): string => buildFilter('publishers', publisher)

/** `decade` as listed in `filterdata.publishedDecades`, e.g. "2010". */
export const publishedDecadeFilter = (decade: string): string => buildFilter('publishedDecades', decade)

export const languageFilter = (language: string): string => buildFilter('languages', language)

/**
 * Authors are filtered by ENTITY ID (`filterdata.authors[].id`, `AbsAuthor.id`), not by name --
 * a name matches nothing. Parameter is named `authorId` so a call with a name reads wrong.
 */
export const authorFilter = (authorId: string): string => buildFilter('authors', authorId)

/** Series are filtered by ENTITY ID (`filterdata.series[].id`, `AbsSeries.id`), not by name. */
export const seriesFilter = (seriesId: string): string => buildFilter('series', seriesId)

export const progressFilter = (value: ProgressFilterValue): string => buildFilter('progress', value)

export interface ParsedFilter {
  group: FilterGroup
  /** Decoded value: a name for most groups, an entity id for `authors`/`series`. */
  value: string
}

/**
 * Splits a filter param back into its group and decoded value; null when it isn't one of the
 * known `<group>.<value>` shapes (e.g. empty, or a valueless server-side filter like `issues`).
 */
export function parseFilter(filter: string | null | undefined): ParsedFilter | null {
  if (!filter) return null
  const dot = filter.indexOf('.')
  if (dot <= 0) return null
  const group = filter.slice(0, dot)
  if (!(FILTER_GROUPS as readonly string[]).includes(group)) return null
  try {
    return { group: group as FilterGroup, value: filterDecode(filter.slice(dot + 1)) }
  } catch {
    return null
  }
}
