import type {
  AbsFilterData,
  AbsLibrary,
  AbsLibraryItem,
  AbsPlaybackSession,
  AbsUser,
  GetLibrariesResponse,
  GetLibraryItemsOptions,
  GetLibraryItemsResponse,
  GetLibraryPersonalizedResponse
} from '../types/abs'
import type { SessionStore } from '../auth/session'

export class AbsApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
  }
}

/** Upper bound for an ordinary ABS API call. Without one, a dead connection leaves the awaiting
 * UI (e.g. the player's "Loading..." state) hanging until the OS gives up, which can be minutes. */
export const REQUEST_TIMEOUT_MS = 10_000

/** Starting a playback session makes the server open/probe the item, which is legitimately slower
 * than a metadata fetch on large libraries -- give it more headroom than [REQUEST_TIMEOUT_MS]. */
export const SESSION_START_TIMEOUT_MS = 20_000

/** Aborts when either input does. Hand-rolled rather than `AbortSignal.any`, which older Android
 * WebViews (pre-Chrome 116) lack; `AbortSignal.timeout` (Chrome 103) is the only newer API used. */
function mergeSignals(first: AbortSignal, second: AbortSignal): AbortSignal {
  const controller = new AbortController()
  const abort = (source: AbortSignal) => () => controller.abort(source.reason)
  if (first.aborted) controller.abort(first.reason)
  else if (second.aborted) controller.abort(second.reason)
  else {
    first.addEventListener('abort', abort(first), { once: true })
    second.addEventListener('abort', abort(second), { once: true })
  }
  return controller.signal
}

/** Page size for `getLibraryItems` when the caller doesn't pick one. 48 divides evenly into both
 * the 3-column and 4-column cover grids, so a full page never leaves a ragged last row. */
export const DEFAULT_LIBRARY_PAGE_SIZE = 48

/** Per-shelf cap for `getLibraryPersonalized`; the server's own default. */
export const DEFAULT_SHELF_LIMIT = 10

/**
 * Builds the query string for `GET /api/libraries/:id/items`.
 *
 * `filter` is appended verbatim because `filterUtils` already URL-encodes its value half;
 * encoding it again would turn the base64 `=` padding into `%253D` and the server would decode it
 * to the wrong value.
 *
 * `collapseseries` is deliberately dropped whenever a `filter` is present. On ABS 2.35.1 the two
 * combined return inconsistent rows (a filtered-out book can still surface through its series
 * wrapper, and `total` stops matching `results`); the fixes landed in commits after that release.
 * Filter wins because a filtered view is an explicit user request and collapse is a presentation
 * nicety. Revisit once the minimum supported server version includes the fix.
 */
export function buildLibraryItemsQuery(options: GetLibraryItemsOptions = {}): string {
  const { page = 0, limit = DEFAULT_LIBRARY_PAGE_SIZE, sort = 'media.metadata.title', desc = false, filter, collapseseries = false, minified = true } = options
  const params = [`limit=${limit}`, `page=${page}`, `sort=${encodeURIComponent(sort)}`]
  if (desc) params.push('desc=1')
  if (filter) params.push(`filter=${filter}`)
  if (collapseseries && !filter) params.push('collapseseries=1')
  if (minified) params.push('minified=1')
  return params.join('&')
}

export interface AbsClientDeps {
  session: SessionStore
  fetcher?: typeof fetch
}

export type { AbsLibrary, GetLibrariesResponse }

export interface StartSessionOptions {
  deviceInfo: { clientName: string; deviceId: string }
  supportedMimeTypes: string[]
  mediaPlayer: string
  forceTranscode: boolean
  forceDirectPlay: boolean
}

/**
 * Token-aware ABS API client. Every call attaches the current bearer access token; a 401
 * triggers exactly one session refresh + retry (SessionStore.refresh), mirroring the web
 * app's fetchBackendWithCookieRefresh behavior for a bearer-token (not cookie) client.
 */
export function createAbsClient(deps: AbsClientDeps) {
  const fetcher = deps.fetcher ?? fetch
  const session = deps.session

  async function request<T>(path: string, init: RequestInit = {}, retried = false, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    const serverUrl = session.getServerUrl()
    const accessToken = session.getAccessToken()
    if (!serverUrl || !accessToken) {
      throw new AbsApiError(401, 'Not authenticated')
    }

    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${accessToken}`)

    // The timeout signal covers the whole exchange (headers and body). A caller-supplied signal
    // is honored too, so either can abort the request.
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const signal = init.signal ? mergeSignals(init.signal, timeoutSignal) : timeoutSignal

    try {
      const response = await fetcher(`${serverUrl}${path}`, { ...init, headers, signal })

      if (response.status === 401 && !retried) {
        const refreshed = await session.refresh()
        if (refreshed) {
          return request<T>(path, init, true, timeoutMs)
        }
      }

      if (!response.ok) {
        const message = await response.text().catch(() => response.statusText)
        throw new AbsApiError(response.status, message || response.statusText)
      }

      return (await response.json()) as T
    } catch (error) {
      // A timeout-driven abort surfaces as a DOMException named TimeoutError -- give callers (and
      // the player's error line) a readable, typed error instead.
      if (timeoutSignal.aborted && !init.signal?.aborted) {
        throw new AbsApiError(408, 'The server took too long to respond')
      }
      throw error
    }
  }

  return {
    getLibraries: () => request<GetLibrariesResponse>('/api/libraries'),

    /** The current user, including `mediaProgress` -- the ONLY source of per-item progress for list
     * screens (list/personalized endpoints never attach it). Index it with `buildProgressMap`. */
    getMe: () => request<AbsUser>('/api/me'),

    /** One page of a library. `total` is the match count across all pages, so a caller can tell
     * whether more remain: `(page + 1) * limit < total`. Defaults: page 0, 48 per page, title
     * ascending, minified. See [buildLibraryItemsQuery] for the filter/collapse rule. */
    getLibraryItems: (libraryId: string, options: GetLibraryItemsOptions = {}, signal?: AbortSignal) =>
      request<GetLibraryItemsResponse>(`/api/libraries/${encodeURIComponent(libraryId)}/items?${buildLibraryItemsQuery(options)}`, { signal }),

    /** The home shelves, passed through as the server sends them (set and order vary by library
     * contents and server version -- render by `type`, skip unknown). `include=rssfeed,share` only
     * adds fields to entities. Order with `orderShelvesHistoryFirst` to put history shelves first. */
    getLibraryPersonalized: (libraryId: string, limit = DEFAULT_SHELF_LIMIT, signal?: AbortSignal) =>
      request<GetLibraryPersonalizedResponse>(`/api/libraries/${encodeURIComponent(libraryId)}/personalized?limit=${limit}&include=rssfeed,share`, { signal }),

    /** Genres/tags/authors/series/etc. to filter by. The server caches this ~30 minutes, so values
     * added recently may be missing (and stale ones present); treat it as a hint, not a source of truth. */
    getFilterData: (libraryId: string, signal?: AbortSignal) => request<AbsFilterData>(`/api/libraries/${encodeURIComponent(libraryId)}/filterdata`, { signal }),

    getLibraryItem: (itemId: string) => request<AbsLibraryItem>(`/api/items/${encodeURIComponent(itemId)}?expanded=1&include=progress`),

    startSession: (itemId: string, options: StartSessionOptions) =>
      request<AbsPlaybackSession>(
        `/api/items/${encodeURIComponent(itemId)}/play`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(options)
        },
        false,
        SESSION_START_TIMEOUT_MS
      ),

    syncSession: (sessionId: string, body: { currentTime: number; timeListened: number }) =>
      request<void>(`/api/session/${encodeURIComponent(sessionId)}/sync`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      }),

    closeSession: (sessionId: string, body: { currentTime: number; timeListened: number }) =>
      request<void>(`/api/session/${encodeURIComponent(sessionId)}/close`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      }),

    /** Appends the current access token as a query param for elements the WebView loads
     * directly (audio/cover <img>/<audio> src) rather than through fetch. */
    authorizedStreamUrl: (contentUrl: string): string => {
      const serverUrl = session.getServerUrl()
      const accessToken = session.getAccessToken()
      const separator = contentUrl.includes('?') ? '&' : '?'
      return `${serverUrl ?? ''}${contentUrl}${separator}token=${encodeURIComponent(accessToken ?? '')}`
    },

    /** Passthroughs for callers that need the raw credentials directly rather than an
     * authenticated fetch -- the native player (WI-1496 t700 Task 3) makes its own ExoPlayer
     * HTTP requests outside this client and needs to hand them to the Capacitor plugin. */
    getServerUrl: (): string | null => session.getServerUrl(),
    getAccessToken: (): string | null => session.getAccessToken()
  }
}

export type AbsClient = ReturnType<typeof createAbsClient>
