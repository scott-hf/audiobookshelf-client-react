/**
 * The library list's filter/sort state, and how it round-trips through the URL query string.
 *
 * It lives in the URL (not component state) so a filtered list survives opening a book and
 * pressing back, and so the book page can deep-link a genre/author/series/narrator tap straight
 * to the right list with a plain `<Link>`.
 *
 * Query params (all optional; absent == default):
 *   filter      the server `filter` string exactly as `filterUtils` builds it, e.g. `genres.QWN0...`
 *   label       display name for an id-keyed filter (author/series) so the chip can name it
 *               without waiting on `/filterdata`
 *   sort        one of {@link LIBRARY_SORT_OPTIONS}[].key
 *   desc        `1` for descending
 *   downloaded  `1` to narrow the list to books saved on this device (client-side, see LibraryPage)
 *
 * The `filter` value is already URL-encoded by `filterUtils`. `URLSearchParams` encodes it a
 * second time on write and decodes that one layer on read, so `params.get('filter')` yields
 * the original `filterUtils` string byte for byte -- do not decode it again.
 */
import type { AbsFilterData } from '../types/abs'
import type { TranslationKey, TypeSafeTranslations } from '../types/translations'
import { buildFilter, parseFilter, type FilterGroup, type ProgressFilterValue } from './filterUtils'

export interface LibrarySortOption {
  /** Server sort key. Never shown to the user. */
  key: string
  labelKey: TranslationKey
  /** Direction applied when this sort is picked: newest-added-first is what people mean by "Added". */
  defaultDesc: boolean
}

/**
 * The subset of the 2.35.1 sort keys worth offering. Deliberately left out:
 *  - `random`: every page request re-shuffles, so "Load more" would repeat and skip books.
 *  - `size`, `birthtimeMs`, `mtimeMs`: file-system details, not how people look for a book.
 *  - `progress`: its handling of never-started books is unverified against the live server.
 */
export const LIBRARY_SORT_OPTIONS: readonly LibrarySortOption[] = [
  { key: 'media.metadata.title', labelKey: 'LabelTitle', defaultDesc: false },
  { key: 'media.metadata.authorName', labelKey: 'LabelAuthorFirstLast', defaultDesc: false },
  { key: 'media.metadata.authorNameLF', labelKey: 'LabelAuthorLastFirst', defaultDesc: false },
  { key: 'media.metadata.publishedYear', labelKey: 'LabelPublishYear', defaultDesc: false },
  { key: 'addedAt', labelKey: 'LabelAddedAt', defaultDesc: true },
  { key: 'media.duration', labelKey: 'LabelDuration', defaultDesc: false }
]

export const DEFAULT_LIBRARY_SORT = 'media.metadata.title'

/** Human label for each filter group (reuses the upstream keys, so wording matches the web app). */
export const FILTER_GROUP_LABEL_KEYS: Record<FilterGroup, TranslationKey> = {
  genres: 'LabelGenre',
  authors: 'LabelAuthor',
  series: 'LabelSeries',
  narrators: 'LabelNarrator',
  progress: 'LabelProgress',
  publishers: 'LabelPublisher',
  languages: 'LabelLanguage',
  publishedDecades: 'LabelPublishedDecade',
  tags: 'LabelTags'
}

export const PROGRESS_LABEL_KEYS: Record<ProgressFilterValue, TranslationKey> = {
  finished: 'LabelFinished',
  'in-progress': 'LabelInProgress',
  'not-started': 'LabelNotStarted',
  'not-finished': 'LabelNotFinished'
}

/**
 * Text for the "active filter" chip, e.g. `Genre: Adventure`. Author/series filters carry an
 * entity id, so the name comes from the URL's `label` (written when the filter was chosen) or,
 * failing that, `/filterdata`; with neither the chip names just the group rather than show an id.
 */
export function describeActiveFilter(query: LibraryQuery, filterData: AbsFilterData | null, t: TypeSafeTranslations): string | null {
  const parsed = parseFilter(query.filter)
  if (!parsed) return null
  const groupLabel = t(FILTER_GROUP_LABEL_KEYS[parsed.group])
  let value: string | null
  switch (parsed.group) {
    case 'authors':
      value = filterData?.authors.find((author) => author.id === parsed.value)?.name ?? query.label
      break
    case 'series':
      value = filterData?.series.find((series) => series.id === parsed.value)?.name ?? query.label
      break
    case 'progress':
      value = PROGRESS_LABEL_KEYS[parsed.value as ProgressFilterValue] ? t(PROGRESS_LABEL_KEYS[parsed.value as ProgressFilterValue]) : parsed.value
      break
    case 'publishedDecades':
      value = t('LabelMobileDecade', { decade: parsed.value })
      break
    default:
      value = parsed.value
  }
  return value ? t('LabelMobileFilterChip', { group: groupLabel, value }) : groupLabel
}

export interface LibraryQuery {
  /** Encoded server filter (`<group>.<value>`), or null. Single filter only -- the server takes one. */
  filter: string | null
  /** Name to show for an id-keyed filter; only meaningful alongside `filter`. */
  label: string | null
  sort: string
  desc: boolean
  /** Client-side "saved on this device" narrowing; independent of `filter`. */
  downloaded: boolean
}

export const DEFAULT_LIBRARY_QUERY: LibraryQuery = { filter: null, label: null, sort: DEFAULT_LIBRARY_SORT, desc: false, downloaded: false }

/** The flat catalogue route. Keep in sync with `App.tsx`; every link into the list goes through here. */
export const libraryBooksPath = (libraryId: string): string => `/library/${encodeURIComponent(libraryId)}/books`

export function parseLibraryQuery(params: URLSearchParams): LibraryQuery {
  const rawFilter = params.get('filter')
  // A hand-edited or stale URL must not send the server a filter it cannot parse.
  const filter = parseFilter(rawFilter) ? rawFilter : null
  const rawSort = params.get('sort')
  const sort = LIBRARY_SORT_OPTIONS.some((option) => option.key === rawSort) ? (rawSort as string) : DEFAULT_LIBRARY_SORT
  return {
    filter,
    label: filter ? params.get('label') || null : null,
    sort,
    desc: params.get('desc') === '1',
    downloaded: params.get('downloaded') === '1'
  }
}

export function toSearchParams(query: LibraryQuery): URLSearchParams {
  const params = new URLSearchParams()
  if (query.filter) {
    params.set('filter', query.filter)
    if (query.label) params.set('label', query.label)
  }
  if (query.sort !== DEFAULT_LIBRARY_SORT) params.set('sort', query.sort)
  if (query.desc) params.set('desc', '1')
  if (query.downloaded) params.set('downloaded', '1')
  return params
}

/**
 * Path to the library list narrowed by one entity -- what a tapped genre/author/series/narrator
 * on the book page links to. Pass the entity ID for `authors`/`series` (and its name as `label`),
 * the literal name for everything else.
 */
export function libraryFilterPath(libraryId: string, group: FilterGroup, value: string, label?: string): string {
  const search = toSearchParams({ ...DEFAULT_LIBRARY_QUERY, filter: buildFilter(group, value), label: label ?? null }).toString()
  return `${libraryBooksPath(libraryId)}?${search}`
}
