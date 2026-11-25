import { z } from 'zod'
import type { DiscoverItem, DiscoverOption } from '@abs/acquisition-contract'
import {
  LibrarrDiscoverBrowseResponseSchema,
  LibrarrDiscoverOptionsResponseSchema,
  type LibrarrDiscoverStatus,
  LibrarrSearchResponseSchema,
  LibrarrSubmitResponseSchema,
  LibrarrDownloadsResponseSchema,
  LibrarrHealthResponseSchema,
  LibrarrLibraryResponseSchema,
  type LibrarrSearchResult,
  type LibrarrSubmitResponse,
  type LibrarrDownloadStatus,
  type LibrarrLibraryItem
} from './librarrSchemas'

export class LibrarrApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message)
    this.name = 'LibrarrApiError'
  }
}

/**
 * Thrown when Librarr does not answer within the call's budget. Distinct from a Librarr error
 * response (`code: 'librarr_timeout'`, never `librarr_error`) so callers can tell "slow or
 * unreachable" from "Librarr said no". It is a LibrarrApiError so existing instanceof checks keep
 * working; status 504 is synthetic -- no HTTP status was received.
 */
export class LibrarrTimeoutError extends LibrarrApiError {
  constructor(
    path: string,
    public timeoutMs: number
  ) {
    // The query string is dropped: it can carry the user's search text.
    super(504, 'librarr_timeout', `Librarr did not respond within ${timeoutMs}ms (${path.split('?')[0]})`)
    this.name = 'LibrarrTimeoutError'
  }
}

/**
 * Librarr fans a search out to several upstream sources, so it gets the longer budget. Healthy
 * searches take ~1-2s and Librarr itself caps each source at 6s, so 10s covers a search with one
 * dead source while still failing fast enough to keep the UI usable. Every other call is a local
 * DB read or a single torrent-client call and gets the shorter budget.
 */
export const LIBRARR_SEARCH_TIMEOUT_MS = 10_000
export const LIBRARR_REQUEST_TIMEOUT_MS = 5_000

/**
 * Budget for `GET /api/discover/browse`, which proxies Open Library.
 *
 * Measured against the live server: 12 browse samples ranged 0.22s to 11.7s (the fast ones are
 * Librarr's own cache), and direct Open Library calls stall for up to 37s. Librarr's own HTTP
 * client to Open Library gives up at 15s and answers `upstream_unavailable` -- as a real HTTP 200
 * body. This budget is deliberately past that 15s ceiling so Librarr's own verdict reaches us as an
 * answer ("Open Library is down", 502 `discover_upstream_unavailable`) instead of as OUR timeout,
 * which would be indistinguishable from Librarr itself being unreachable. A successful 11.7s
 * response is real, so do not "optimise" this back toward the 5s/10s budgets above.
 */
export const LIBRARR_BROWSE_TIMEOUT_MS = 20_000

export interface LibrarrClientOptions {
  baseUrl: string
  apiKey: string
  fetcher?: typeof fetch
  /** Budget for the audiobook search. Defaults to LIBRARR_SEARCH_TIMEOUT_MS. */
  searchTimeoutMs?: number
  /** Budget for discover browse. Defaults to LIBRARR_BROWSE_TIMEOUT_MS. */
  browseTimeoutMs?: number
  /** Budget for every other call. Defaults to LIBRARR_REQUEST_TIMEOUT_MS. */
  timeoutMs?: number
}

/**
 * Classifies a non-2xx Librarr response into a stable, machine-readable code. In particular
 * detects Librarr's "SABnzbd not configured" 400 (internal/api/download.go:504-509) so callers
 * can surface it as a stable non-retryable error instead of a generic submit failure -- this
 * deployment runs Decypharr's qBittorrent facade only, never SABnzbd (WI-1496 correction #3).
 */
function classifyError(status: number, body: unknown): string {
  const message = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : ''
  if (status === 400 && message.toLowerCase().includes('sabnzbd not configured')) return 'sabnzbd_not_configured'
  if (status === 409) return 'already_in_library'
  return 'librarr_error'
}

const successSchema = z.object({ success: z.boolean() })

/** `GET /api/discover/options`, with unusable (blank id or label) entries dropped. */
export interface LibrarrDiscoverOptions {
  catalogs: DiscoverOption[]
  genres: DiscoverOption[]
}

/**
 * A browse answer in camelCase, with the item quirks normalised, but otherwise exactly what
 * Librarr said -- including its failure statuses. Turning `upstream_unavailable` and
 * `rate_limited` into HTTP errors is the route's job, not the adapter's.
 */
export interface LibrarrDiscoverBrowse {
  status: LibrarrDiscoverStatus
  /** Librarr's human-readable reason; `''` on a success. */
  error: string
  /** Librarr's echo of the request. `undefined` when it did not send one (always, on an outage). */
  catalog?: string
  genre?: string
  offset?: number
  /** `null` = last page. Failure statuses are always `null`. NOT yet validated against the
   * request offset -- that needs the request, so the route does it. */
  nextOffset: number | null
  partial: boolean
  items: DiscoverItem[]
  /** Raw `Retry-After` header of Librarr's response, if any (meaningful for `rate_limited`). */
  retryAfter: string | null
}

export class LibrarrClient {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly fetcher: typeof fetch
  private readonly searchTimeoutMs: number
  private readonly browseTimeoutMs: number
  private readonly timeoutMs: number

  constructor(options: LibrarrClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '')
    this.apiKey = options.apiKey
    this.fetcher = options.fetcher ?? fetch
    this.searchTimeoutMs = options.searchTimeoutMs ?? LIBRARR_SEARCH_TIMEOUT_MS
    this.browseTimeoutMs = options.browseTimeoutMs ?? LIBRARR_BROWSE_TIMEOUT_MS
    this.timeoutMs = options.timeoutMs ?? LIBRARR_REQUEST_TIMEOUT_MS
  }

  // Duck-typed instead of z.ZodType<T> -- with a `.default()` in the schema, zod's Input and
  // Output types diverge, and binding both to a single generic T via ZodType<T> makes
  // TypeScript infer T from the (optional-fields) Input side, not the parsed Output side.
  private async request<T>(
    path: string,
    schema: { parse: (data: unknown) => T },
    init: RequestInit = {},
    timeoutMs: number = this.timeoutMs
  ): Promise<T> {
    return (await this.requestWithHeaders(path, schema, init, timeoutMs)).data
  }

  /** `request`, but also hands back the response headers for the callers that need one. */
  private async requestWithHeaders<T>(
    path: string,
    schema: { parse: (data: unknown) => T },
    init: RequestInit = {},
    timeoutMs: number = this.timeoutMs
  ): Promise<{ data: T; headers: Headers }> {
    const headers = new Headers(init.headers)
    headers.set('x-api-key', this.apiKey)
    // The deadline covers connecting, headers and the body read, so a Librarr that accepts the
    // connection and then stalls cannot hang the caller either.
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    // A caller's own signal (its client went away) is combined with the deadline, not replaced by it.
    const callerSignal = init.signal ?? undefined
    const signal = callerSignal ? AbortSignal.any([controller.signal, callerSignal]) : controller.signal
    let response: Response
    let body: unknown = null
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, { ...init, headers, signal })
      try {
        body = await response.json()
      } catch {
        body = null
      }
    } catch (error) {
      if (timedOut) throw new LibrarrTimeoutError(path, timeoutMs)
      throw error
    } finally {
      clearTimeout(timer)
    }
    // A body read cut off by the deadline lands in the inner catch as `null`; it is still a timeout.
    if (timedOut) throw new LibrarrTimeoutError(path, timeoutMs)
    // Likewise a body read cut off by the caller: surface the abort (an AbortError, never a
    // TypeError) instead of letting the swallowed read fall through to schema parsing.
    if (callerSignal?.aborted) throw callerSignal.reason ?? new DOMException('The operation was aborted', 'AbortError')
    if (!response.ok) {
      const code = classifyError(response.status, body)
      const message =
        body && typeof body === 'object' && 'error' in body
          ? String((body as { error: unknown }).error)
          : `Librarr request failed with status ${response.status}`
      throw new LibrarrApiError(response.status, code, message)
    }
    return { data: schema.parse(body), headers: response.headers }
  }

  async searchAudiobooks(query: string): Promise<LibrarrSearchResult[]> {
    const response = await this.request(
      `/api/search/audiobooks?${new URLSearchParams({ q: query })}`,
      LibrarrSearchResponseSchema,
      {},
      this.searchTimeoutMs
    )
    return response.results
  }

  /** GET /api/discover/options -- the catalogs and genres the browse screen can offer. */
  async getDiscoverOptions(): Promise<LibrarrDiscoverOptions> {
    const response = await this.request('/api/discover/options', LibrarrDiscoverOptionsResponseSchema)
    if (response.status !== 'ok') {
      throw new LibrarrApiError(502, 'librarr_error', response.error || `Librarr discover options returned status ${response.status}`)
    }
    const usable = (option: DiscoverOption) => option.id.length > 0 && option.label.length > 0
    return { catalogs: response.catalogs.filter(usable), genres: response.genres.filter(usable) }
  }

  /**
   * GET /api/discover/browse. Resolves with Librarr's answer whatever its `status` -- Librarr
   * reports an Open Library outage as an HTTP 200 body, and that body must parse (see
   * LibrarrDiscoverBrowseResponseSchema). `genre` is omitted from the query when empty, never
   * sent as `genre=`. Uses the long browse budget, not the 5s default (LIBRARR_BROWSE_TIMEOUT_MS).
   */
  async browseDiscover(
    catalog: string,
    genre: string | undefined,
    offset: number,
    /** Aborts the Librarr request when the caller goes away; rejects with an AbortError. */
    signal?: AbortSignal
  ): Promise<LibrarrDiscoverBrowse> {
    const query = new URLSearchParams({ catalog })
    if (genre) query.set('genre', genre)
    query.set('offset', String(offset))
    const { data, headers } = await this.requestWithHeaders(
      `/api/discover/browse?${query}`,
      LibrarrDiscoverBrowseResponseSchema,
      signal ? { signal } : {},
      this.browseTimeoutMs
    )
    const succeeded = data.status === 'ok' || data.status === 'empty'
    return {
      status: data.status,
      error: data.error,
      catalog: data.catalog,
      genre: data.genre,
      offset: data.offset,
      nextOffset: succeeded ? (data.next_offset ?? null) : null,
      partial: data.partial,
      items: data.items.map((item) => ({
        key: item.key,
        title: item.title,
        author: item.author ?? '',
        coverUrl: item.cover_url ? item.cover_url : null,
        year: Number.isInteger(item.year) && (item.year as number) > 0 ? (item.year as number) : null,
        popularity: Number.isInteger(item.popularity) ? (item.popularity as number) : null
      })),
      retryAfter: headers.get('retry-after')
    }
  }

  /**
   * Submits the exact raw snapshot entry as Librarr's DownloadRequest body. SearchResult and
   * DownloadRequest share JSON field names for every field the gateway forwards (book.go:7-63
   * vs 188-204), so this is a byte-for-byte passthrough of the stored snapshot, never a
   * reconstructed object -- required so Librarr resolves the exact release the user picked.
   */
  async submitAudiobook(result: LibrarrSearchResult): Promise<LibrarrSubmitResponse> {
    return this.request('/api/download/audiobook', LibrarrSubmitResponseSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(result)
    })
  }

  async getDownloads(): Promise<LibrarrDownloadStatus[]> {
    const response = await this.request('/api/downloads', LibrarrDownloadsResponseSchema)
    return response.downloads
  }

  async deleteTorrent(hash: string): Promise<boolean> {
    const response = await this.request(`/api/downloads/torrent/${encodeURIComponent(hash)}`, successSchema, {
      method: 'DELETE'
    })
    return response.success
  }

  async deleteJob(jobId: string): Promise<boolean> {
    const response = await this.request(`/api/downloads/novel/${encodeURIComponent(jobId)}`, successSchema, {
      method: 'DELETE'
    })
    return response.success
  }

  async retryJob(jobId: string): Promise<boolean> {
    const response = await this.request(`/api/downloads/jobs/${encodeURIComponent(jobId)}/retry`, successSchema, {
      method: 'POST'
    })
    return response.success
  }

  /**
   * Librarr's own local library rows, paged. With ABS unset in Librarr (mandated by
   * 02-SETTLED-DECISIONS.md) this serves the local-DB fallback, which is what carries the
   * `source_id` -> `file_path` mapping the gateway correlates on
   * (docs/handoff/correlation-note.md section 2).
   */
  async getLibraryAudiobooks(page = 1): Promise<LibrarrLibraryItem[]> {
    const response = await this.request(
      `/api/library/audiobooks?${new URLSearchParams({ page: String(page) })}`,
      LibrarrLibraryResponseSchema
    )
    return response.items
  }

  /** Every local audiobook row, paged (Librarr's local fallback pages at 100). */
  async getAllLibraryAudiobooks(): Promise<LibrarrLibraryItem[]> {
    const all: LibrarrLibraryItem[] = []
    for (let page = 1; page <= 200; page += 1) {
      const items = await this.getLibraryAudiobooks(page)
      all.push(...items)
      if (items.length < 100) break
    }
    return all
  }

  /**
   * DELETE /api/library/audiobook/{id} (internal/api/router.go:311 -> handleDeleteBook,
   * library_external.go:410 `{"success": true}`). Removing the row after a confirmed import
   * is mandatory, not hygiene: the row's `in_library` dedupe would otherwise block a future
   * acquisition of the same book (correlation-note.md section 6).
   */
  async deleteLibraryAudiobook(id: string | number): Promise<boolean> {
    const response = await this.request(`/api/library/audiobook/${encodeURIComponent(String(id))}`, successSchema, {
      method: 'DELETE'
    })
    return response.success
  }

  /** GET /api/health (internal/api/health.go:29-63) -- real liveness+readiness probe. */
  async health(): Promise<boolean> {
    try {
      const response = await this.request('/api/health', LibrarrHealthResponseSchema)
      return response.status === 'ok'
    } catch {
      return false
    }
  }
}
