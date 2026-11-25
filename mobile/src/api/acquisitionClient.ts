import { AcquisitionApiError, AcquisitionTimeoutError, createAcquisitionClient, type AcquisitionStatusResponse } from '@abs/acquisition-client'
import type { SessionStore } from '../auth/session'

export { AcquisitionApiError, AcquisitionTimeoutError }
export type { AcquisitionStatusResponse }

function withSessionRefreshRetry<Args extends unknown[], T>(session: SessionStore, fn: (...args: Args) => Promise<T>): (...args: Args) => Promise<T> {
  return async (...args: Args): Promise<T> => {
    try {
      return await fn(...args)
    } catch (error) {
      if (error instanceof AcquisitionApiError && error.status === 401 && (await session.refresh())) {
        return fn(...args)
      }
      throw error
    }
  }
}

/**
 * Bearer-token acquisition-gateway client for ShelfDroid. Mirrors the web app's
 * src/lib/acquisition.ts one-retry-on-401 wrapper (withSessionRefreshRetry), but refreshes
 * through SessionStore.refresh() (ABS POST /auth/refresh, see auth/session.ts) instead of the
 * web app's cookie-based /internal-api/refresh route -- mobile carries bearer tokens, never
 * cookies. The gateway itself (services/acquisition-gateway/src/auth/absAuth.ts) accepts a
 * bearer `authorization` header exactly the same way it accepts the web app's `access_token`
 * cookie, so no gateway change was needed.
 *
 * Only call once a session is authenticated (SessionStore.getServerUrl() is non-null) --
 * AuthProvider only constructs this after state.status === 'authenticated'.
 */
export function createMobileAcquisitionClient(session: SessionStore, fetcher?: typeof fetch) {
  const serverUrl = session.getServerUrl()
  if (!serverUrl) {
    throw new Error('createMobileAcquisitionClient requires an authenticated session')
  }
  const baseClient = createAcquisitionClient({
    baseUrl: `${serverUrl}/acquisition-api/v1`,
    getAccessToken: async () => session.getAccessToken(),
    fetcher,
    // ShelfDroid is a pure bearer-token client calling the gateway cross-origin (a real
    // ABS host, not a same-origin Next proxy) -- 'include' would require the gateway to
    // echo Access-Control-Allow-Credentials for an exact origin, which it has no reason to
    // do for a bearer-only caller; the browser CORS-rejects the response otherwise. See
    // AcquisitionClientOptions.credentials in @abs/acquisition-client.
    credentials: 'omit'
  })
  return {
    status: withSessionRefreshRetry(session, baseClient.status),
    searchAudiobooks: withSessionRefreshRetry(session, baseClient.searchAudiobooks),
    // The caller's AbortSignal travels inside `args` (the RequestOptions argument), and the
    // wrapper replays the very same `args` on the post-refresh retry, so a selection change that
    // aborts the first attempt still aborts the retry.
    getDiscoverOptions: withSessionRefreshRetry(session, baseClient.getDiscoverOptions),
    browseDiscover: withSessionRefreshRetry(session, baseClient.browseDiscover),
    createAcquisition: withSessionRefreshRetry(session, baseClient.createAcquisition),
    listAcquisitions: withSessionRefreshRetry(session, baseClient.listAcquisitions),
    getAcquisition: withSessionRefreshRetry(session, baseClient.getAcquisition),
    retryAcquisition: withSessionRefreshRetry(session, baseClient.retryAcquisition),
    cancelAcquisition: withSessionRefreshRetry(session, baseClient.cancelAcquisition)
  }
}

export type MobileAcquisitionClient = ReturnType<typeof createMobileAcquisitionClient>

const GATEWAY_ERROR_MESSAGES: Record<string, string> = {
  search_not_found: 'This search has expired. Search again.',
  search_expired: 'This search has expired. Search again.',
  release_not_found: 'That release could not be found.',
  release_not_trackable: 'That release cannot be tracked right now.',
  library_forbidden: 'You do not have access to this library.',
  library_mismatch: 'You do not have access to this library.',
  acquisition_not_found: 'That acquisition could not be found.',
  acquisition_not_retryable: 'That acquisition cannot be retried.',
  acquisition_not_cancellable: 'That acquisition cannot be cancelled.',
  gateway_not_ready: 'The acquisition gateway is not ready yet.',
  // Matched by code before the generic 404/5xx branches below, so a `discover_not_supported` 404
  // is never reported as "the acquisition service is not available on this server".
  discover_upstream_unavailable: 'Open Library is temporarily unavailable. Search still works.',
  discover_rate_limited: 'Too many requests to Open Library. Try again in a minute.',
  discover_not_supported: 'Book suggestions are not available on this server.',
  // The gateway fails closed on a Librarr reply it cannot parse (e.g. an unknown `status`).
  discover_bad_response: 'Book suggestions could not be loaded.',
  // Gateway-wide Librarr failures, shared by search, acquisitions and Discover, so the copy names
  // neither the feature nor the component behind it. A timeout is the likeliest real failure.
  librarr_timeout: 'The server took too long to answer. Try again.',
  librarr_unreachable: 'The server could not reach a service it depends on. Try again in a moment.',
  librarr_error: 'The server could not complete that request. Try again.'
}

/**
 * Never echoes a raw upstream message verbatim into the UI -- same policy as the web app's
 * formatAcquisitionError (src/lib/acquisition.ts), without the next-intl dependency mobile
 * does not carry.
 *
 * Beyond the known gateway codes, the two failures worth separating are the ones where
 * "please try again" is actively wrong: the gateway not being routable on this server (the
 * ABS host answers, but nothing serves /acquisition-api/, so the 404 body is HTML with no
 * gateway code), and the request never reaching it at all (offline, or a cross-origin block).
 * Retrying fixes neither, and telling someone to retry hides a server-side misconfiguration.
 */
export function formatAcquisitionError(error: unknown): string {
  // Checked before AcquisitionApiError: a deadline means the gateway never answered, so none of
  // the status-based messages below apply and "try again" is the only honest advice.
  if (error instanceof AcquisitionTimeoutError) {
    return 'The acquisition service did not respond in time. It may still be busy -- try again in a moment.'
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return 'Search cancelled.'
  }
  if (error instanceof AcquisitionApiError) {
    const known = GATEWAY_ERROR_MESSAGES[error.code]
    if (known) return known
    if (error.status === 404) return 'The acquisition service is not available on this server.'
    if (error.status === 401 || error.status === 403) return 'You are not authorized to use the acquisition service.'
    if (error.status >= 500) return `The acquisition service returned an error (${error.status}). Try again shortly.`
    return `The acquisition service rejected the request (${error.status}).`
  }
  // `fetch` rejects with TypeError for every pre-response failure -- offline, DNS, connection
  // refused, and CORS rejections are indistinguishable here by design.
  if (error instanceof TypeError) {
    return 'Could not reach the acquisition service. Check your connection and that the server exposes it.'
  }
  return 'Something went wrong. Please try again.'
}
