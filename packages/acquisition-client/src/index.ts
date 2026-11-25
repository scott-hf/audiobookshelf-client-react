import type {
  Acquisition,
  CreateAcquisitionBody,
  DiscoverBrowseResponse,
  DiscoverOptionsResponse,
  SearchResponse
} from '@abs/acquisition-contract'

export class AcquisitionApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message)
  }
}

/** A request that never came back within its budget. Distinct from `AcquisitionApiError` (the
 * gateway answered and said no) and from `fetch`'s TypeError (it failed before any response):
 * nothing was learned at all, so the UI must say "timed out", not "check your connection". */
export class AcquisitionTimeoutError extends Error {
  constructor(public timeoutMs: number) {
    super(`Acquisition request timed out after ${timeoutMs}ms`)
  }
}

/** Every gateway call gets a deadline. Without one a request that hangs -- an origin that
 * accepts the connection but never answers, a stalled indexer upstream of the gateway -- leaves
 * the caller's "loading" state on forever with no error path: the mobile Discover page spun
 * indefinitely on exactly this. Mirrors the ABS client's own REQUEST_TIMEOUT_MS. */
export const DEFAULT_TIMEOUT_MS = 15_000

/** Searching fans out to external indexers through Librarr, which is legitimately slower than
 * the gateway's own bookkeeping calls; a 15s deadline would cut off searches that were going to
 * succeed. Still finite, so a dead indexer cannot hang the UI. */
export const SEARCH_TIMEOUT_MS = 45_000

/** Browsing book suggestions goes gateway -> Librarr -> Open Library. The gateway allows 20s for
 * Librarr alone (Librarr itself gives up on Open Library at 15s), and Open Library has been
 * measured stalling past 35s, so a tighter deadline here would abort requests that were about to
 * succeed or about to come back as a proper `discover_upstream_unavailable`. Still finite. */
export const BROWSE_TIMEOUT_MS = 45_000

export interface AcquisitionStatusResponse {
  version: string
  ready: boolean
  librarr: { reachable: boolean }
  staging: { ready: boolean }
  libraries: { id: string; enabled: boolean }[]
}

export interface AcquisitionClientOptions {
  baseUrl: string
  getAccessToken?: () => Promise<string | null>
  fetcher?: typeof fetch
  /** Default 'include' -- correct for the web app's same-origin `/acquisition-api/v1` proxy
   * (needs the ABS session cookie forwarded). A pure bearer-token caller calling the gateway
   * cross-origin (e.g. mobile ShelfDroid) must override this to 'omit': a cross-origin request
   * with credentials 'include' requires the server to echo back a non-wildcard
   * Access-Control-Allow-Origin plus Access-Control-Allow-Credentials, which a bearer-only
   * backend has no reason to set -- the browser silently rejects the response as a CORS
   * failure and fetch rejects with a generic TypeError, not a 401/AcquisitionApiError. */
  credentials?: RequestCredentials
  /** Per-request deadline for everything but search; see DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number
  /** Deadline for `searchAudiobooks`; see SEARCH_TIMEOUT_MS. */
  searchTimeoutMs?: number
  /** Deadline for `browseDiscover`; see BROWSE_TIMEOUT_MS. */
  browseTimeoutMs?: number
}

interface RequestOptions {
  timeoutMs?: number
  /** Caller-supplied cancellation (e.g. a user navigating away, or a newer search). Aborting it
   * rejects with the caller's own abort reason, not AcquisitionTimeoutError. */
  signal?: AbortSignal
}

export function createAcquisitionClient(options: AcquisitionClientOptions) {
  const fetcher = options.fetcher ?? fetch
  const request = async <T>(path: string, init: RequestInit = {}, requestOptions: RequestOptions = {}): Promise<T> => {
    const headers = new Headers(init.headers)
    headers.set('accept', 'application/json')
    const token = await options.getAccessToken?.()
    if (token) headers.set('authorization', `Bearer ${token}`)

    const timeoutMs = requestOptions.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    const abortCaller = () => controller.abort()
    // Checked before subscribing: `getAccessToken` is awaited above, so a caller that aborts
    // synchronously after calling us has already fired by the time we get here, and a listener
    // added to an aborted signal never runs -- the request would hang to its own deadline.
    if (requestOptions.signal?.aborted) abortCaller()
    else requestOptions.signal?.addEventListener('abort', abortCaller)

    let response: Response
    try {
      response = await fetcher(`${options.baseUrl}${path}`, { ...init, headers, credentials: options.credentials ?? 'include', signal: controller.signal })
    } catch (error) {
      // Our own deadline fired: report it as such. A caller-driven abort, or any other
      // pre-response failure (offline, DNS, CORS), propagates unchanged.
      if (timedOut && !requestOptions.signal?.aborted) throw new AcquisitionTimeoutError(timeoutMs)
      throw error
    } finally {
      clearTimeout(timer)
      requestOptions.signal?.removeEventListener('abort', abortCaller)
    }

    // Read as text first and parse defensively. `response.json()` on a non-JSON body throws a
    // SyntaxError that carries no status, which hid the one case callers most need to tell apart:
    // an origin that serves the app but does not route the gateway answers 404 with an HTML page,
    // and the status code is what identifies it.
    const text = await response.text()
    let body: { code?: string; message?: string } | null = null
    try {
      body = text ? (JSON.parse(text) as { code?: string; message?: string }) : null
    } catch {
      body = null
    }
    if (!response.ok) {
      throw new AcquisitionApiError(response.status, body?.code ?? 'gateway_error', body?.message ?? 'Gateway request failed')
    }
    if (body === null) {
      throw new AcquisitionApiError(response.status, 'gateway_error', 'Gateway returned a non-JSON response')
    }
    return body as T
  }
  return {
    status: (requestOptions?: RequestOptions) => request<AcquisitionStatusResponse>('/status', {}, requestOptions),
    // `q` is typed text: trimmed here so no caller can put padding on the wire (the gateway trims
    // too, but a client that sends it clean avoids relying on that). `libraryId` is an opaque id.
    searchAudiobooks: (libraryId: string, q: string, requestOptions: RequestOptions = {}) =>
      request<SearchResponse>(`/search/audiobooks?${new URLSearchParams({ libraryId, q: q.trim() })}`, {}, { timeoutMs: options.searchTimeoutMs ?? SEARCH_TIMEOUT_MS, ...requestOptions }),
    getDiscoverOptions: (requestOptions: RequestOptions = {}) => request<DiscoverOptionsResponse>('/discover/options', {}, requestOptions),
    browseDiscover: (params: { catalog: string; genre?: string; offset?: number }, requestOptions: RequestOptions = {}) => {
      const query = new URLSearchParams({ catalog: params.catalog })
      if (params.genre) query.set('genre', params.genre)
      if (params.offset !== undefined) query.set('offset', String(params.offset))
      return request<DiscoverBrowseResponse>(`/discover/browse?${query}`, {}, { timeoutMs: options.browseTimeoutMs ?? BROWSE_TIMEOUT_MS, ...requestOptions })
    },
    createAcquisition: (libraryId: string, body: CreateAcquisitionBody) =>
      request<Acquisition>(`/acquisitions?${new URLSearchParams({ libraryId })}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      }),
    listAcquisitions: (libraryId: string) => request<Acquisition[]>(`/acquisitions?${new URLSearchParams({ libraryId })}`),
    getAcquisition: (acquisitionId: string) => request<Acquisition>(`/acquisitions/${acquisitionId}`),
    retryAcquisition: (acquisitionId: string) => request<Acquisition>(`/acquisitions/${acquisitionId}/retry`, { method: 'POST' }),
    cancelAcquisition: (acquisitionId: string) => request<Acquisition>(`/acquisitions/${acquisitionId}`, { method: 'DELETE' })
  }
}
