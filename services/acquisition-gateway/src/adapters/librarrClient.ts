import { z } from 'zod'
import {
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

export interface LibrarrClientOptions {
  baseUrl: string
  apiKey: string
  fetcher?: typeof fetch
  /** Budget for the audiobook search. Defaults to LIBRARR_SEARCH_TIMEOUT_MS. */
  searchTimeoutMs?: number
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

export class LibrarrClient {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly fetcher: typeof fetch
  private readonly searchTimeoutMs: number
  private readonly timeoutMs: number

  constructor(options: LibrarrClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '')
    this.apiKey = options.apiKey
    this.fetcher = options.fetcher ?? fetch
    this.searchTimeoutMs = options.searchTimeoutMs ?? LIBRARR_SEARCH_TIMEOUT_MS
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
    let response: Response
    let body: unknown = null
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, { ...init, headers, signal: controller.signal })
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
    if (!response.ok) {
      const code = classifyError(response.status, body)
      const message =
        body && typeof body === 'object' && 'error' in body
          ? String((body as { error: unknown }).error)
          : `Librarr request failed with status ${response.status}`
      throw new LibrarrApiError(response.status, code, message)
    }
    return schema.parse(body)
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
