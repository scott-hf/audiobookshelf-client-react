export interface AbsLibrary {
  id: string
  name: string
  mediaType: 'book' | 'podcast'
}

export interface GetLibrariesResponse {
  libraries: AbsLibrary[]
}

export interface AbsMediaProgress {
  currentTime: number
  duration: number
  isFinished: boolean
  /** Fraction 0..1 (not a percentage). */
  progress: number
}

/**
 * One row of `GET /api/me` -> `mediaProgress`: the per-user progress record for a library item
 * (`episodeId` null) or a podcast episode. This is the only place the list endpoints' progress
 * lives -- `GET /api/libraries/:id/items` never attaches it to the items themselves.
 */
export interface AbsUserMediaProgress extends AbsMediaProgress {
  id: string
  libraryItemId: string
  /** Null for books; set for podcast episodes. */
  episodeId?: string | null
  /** True when the user removed the item from Continue Listening without finishing it. */
  hideFromContinueListening?: boolean
  /** Epoch ms of the last progress write; used to order "continue" shelves. */
  lastUpdate?: number
  startedAt?: number
  finishedAt?: number | null
}

/** `GET /api/me`. Only the fields the mobile client reads are typed; the rest passes through. */
export interface AbsUser {
  id: string
  username: string
  type?: string
  mediaProgress: AbsUserMediaProgress[]
}

/** One chapter as ABS reports it on an expanded library item (`start`/`end` in seconds). */
export interface AbsChapter {
  id: number
  start: number
  end: number
  title: string
}

/** An `{ id, name }` entity reference (authors, series) as filter data and item metadata give it. */
export interface AbsNamedRef {
  id: string
  name: string
}

/** Author ref as on an expanded item's `media.metadata.authors`. */
export type AbsAuthorRef = AbsNamedRef

/** A book's membership in a series (`media.metadata.series`); `sequence` is a free-text "1", "2.5". */
export interface AbsSeriesRef {
  id: string
  name: string
  sequence?: string | null
}

export interface AbsLibraryItemMetadata {
  title: string
  subtitle?: string | null
  authorName?: string | null
  narratorName?: string | null
  /** Display string, e.g. "Mistborn #1". Present on list and expanded results. */
  seriesName?: string | null
  description?: string | null
  /** Genre NAMES (filter by name via `genreFilter`). Expected on minified and expanded items; verify
   * against a live 2.35.1 server before relying on it for the non-minified `/items` response. */
  genres?: string[] | null
  publishedYear?: string | null
  /** Structured refs -- expanded item (`getLibraryItem`) only, not minified list results. */
  authors?: AbsAuthorRef[] | null
  series?: AbsSeriesRef[] | null
  narrators?: string[] | null
}

export interface AbsLibraryItemMedia {
  metadata: AbsLibraryItemMetadata
  /** Tag NAMES (filter by name via `tagFilter`). Lives on `media`, not `media.metadata`. */
  tags?: string[] | null
  coverPath?: string | null
  duration?: number | null
  /** Only present on an expanded item (`getLibraryItem`), not on list results. */
  chapters?: AbsChapter[] | null
}

/**
 * Present on a list result only when the request used `collapseseries=1`: the row stands for a
 * whole series and `id`/`media` are those of its first book.
 */
export interface AbsCollapsedSeries {
  id: string
  name: string
  nameIgnorePrefix?: string
  libraryItemIds: string[]
  numBooks: number
}

export interface AbsLibraryItem {
  id: string
  libraryId: string
  media: AbsLibraryItemMedia
  addedAt?: number
  updatedAt?: number
  /** Only set on collapsed-series rows (see [AbsCollapsedSeries]). */
  collapsedSeries?: AbsCollapsedSeries | null
  /** Set only by `GET /items/:id?include=progress` -- NEVER by the list/personalized endpoints.
   * Resolve list progress from the user progress map (`useUserProgress`) instead. */
  userMediaProgress?: AbsMediaProgress | null
}

export interface GetLibraryItemsResponse {
  results: AbsLibraryItem[]
  /** Total matching items across ALL pages (not `results.length`). */
  total: number
  /** Echoes of what the server applied; absent from older/mocked responses. */
  limit?: number
  page?: number
  sortBy?: string
  sortDesc?: boolean
  filterBy?: string | null
  collapseseries?: boolean
  minified?: boolean
}

/** Options for `client.getLibraryItems`. All optional; see the client for defaults. */
export interface GetLibraryItemsOptions {
  /** Zero-based page index. */
  page?: number
  /** Page size. 0 means "all" on the server -- avoid it on a large library. */
  limit?: number
  /** Server sort key, e.g. `media.metadata.title`, `addedAt`, `media.duration`. */
  sort?: string
  desc?: boolean
  /** An already-encoded filter such as `genres.<encoded>`; build with `filterUtils`. */
  filter?: string | null
  /** Collapse each series to one row. IGNORED when `filter` is set -- see the client comment. */
  collapseseries?: boolean
  /** Smaller payload (no chapters/audio files). The list screens never need the full shape. */
  minified?: boolean
}

// ----------------------------------------------------------------------------
// Personalized shelves (`GET /api/libraries/:id/personalized`)
// ----------------------------------------------------------------------------

/** Shelf entity kinds the server is known to send. Open-ended on purpose -- see [AbsShelf.type]. */
export type AbsShelfType = 'book' | 'series' | 'authors' | 'podcast' | 'episode'

/**
 * One shelf, exactly as the server sent it. The set of shelves (and their `id`s) varies with
 * library contents and server version, so nothing here is a closed union: `type` accepts any
 * string and `entities` is `unknown[]` until narrowed with the guards in `api/shelfUtils.ts`
 * (`isBookShelf`, `isSeriesShelf`, `isAuthorsShelf`). Render by `type`; skip what you don't know.
 *
 * Known 2.x ids (not guaranteed, never switch on them exhaustively): `continue-listening`,
 * `continue-series`, `recently-added`, `recent-series`, `discover`, `listen-again`,
 * `newest-authors` (podcast libraries add `newest-episodes`).
 */
export interface AbsShelf {
  id: string
  /** Server-localised label (English unless the server is configured otherwise). */
  label: string
  /** Web-client i18n key, e.g. `LabelContinueListening`. Mobile has no such key set; use `label`. */
  labelStringKey: string
  type: AbsShelfType | (string & {})
  entities: unknown[]
  total: number
}

/** A series as it appears in a `series` shelf (and, minimally, in filter data). */
export interface AbsSeries {
  id: string
  name: string
  nameIgnorePrefix?: string
  /** The series' books (minified items) in sequence order, as the shelf endpoint returns them. */
  books?: AbsLibraryItem[]
  addedAt?: number
}

/** An author as it appears in an `authors` shelf. */
export interface AbsAuthor {
  id: string
  name: string
  numBooks?: number
  imagePath?: string | null
  libraryId?: string
}

export interface AbsBookShelf extends AbsShelf {
  type: 'book'
  entities: AbsLibraryItem[]
}

export interface AbsSeriesShelf extends AbsShelf {
  type: 'series'
  entities: AbsSeries[]
}

export interface AbsAuthorsShelf extends AbsShelf {
  type: 'authors'
  entities: AbsAuthor[]
}

/** `GET /api/libraries/:id/personalized` returns a bare array of shelves. */
export type GetLibraryPersonalizedResponse = AbsShelf[]

// ----------------------------------------------------------------------------
// Filter data (`GET /api/libraries/:id/filterdata`)
// ----------------------------------------------------------------------------

/**
 * Values available to filter a library by. Note the asymmetry the filter encoding depends on:
 * authors and series are `{ id, name }` objects and the filter value is the ID; everything else
 * is a plain string and the filter value is that string itself.
 *
 * The server caches this for ~30 minutes, so a just-added genre/tag/author can be missing, and
 * an item can be filtered out of existence by a value that is listed here. Treat it as a hint.
 */
export interface AbsFilterData {
  authors: AbsNamedRef[]
  genres: string[]
  tags: string[]
  series: AbsNamedRef[]
  narrators: string[]
  languages: string[]
  publishers?: string[]
  publishedDecades?: string[]
  numIssues?: number
  loadedAt?: number
}

export interface AbsAudioTrack {
  index: number
  contentUrl: string
  duration: number
}

export interface AbsPlaybackSession {
  id: string
  currentTime: number
  audioTracks: AbsAudioTrack[]
}
