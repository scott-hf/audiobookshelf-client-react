import { AcquisitionApiError, createAcquisitionClient, type AcquisitionStatusResponse } from '@abs/acquisition-client'
import type { SessionStore } from '../auth/session'

export { AcquisitionApiError }
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
    fetcher
  })
  return {
    status: withSessionRefreshRetry(session, baseClient.status),
    searchAudiobooks: withSessionRefreshRetry(session, baseClient.searchAudiobooks),
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
  gateway_not_ready: 'The acquisition gateway is not ready yet.'
}

/** Never echoes a raw upstream message verbatim into the UI -- same policy as the web app's
 * formatAcquisitionError (src/lib/acquisition.ts), without the next-intl dependency mobile
 * does not carry. */
export function formatAcquisitionError(error: unknown): string {
  if (error instanceof AcquisitionApiError) {
    return GATEWAY_ERROR_MESSAGES[error.code] ?? 'Something went wrong. Please try again.'
  }
  return 'Something went wrong. Please try again.'
}
