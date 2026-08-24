'use client'

import { AcquisitionApiError, createAcquisitionClient, type AcquisitionStatusResponse } from '@abs/acquisition-client'
import type { TranslationKey, TypeSafeTranslations } from '@/types/translations'

export type { AcquisitionStatusResponse }
export { AcquisitionApiError }

const ACQUISITION_API_BASE_URL = '/acquisition-api/v1'

let refreshInFlight: Promise<boolean> | null = null

/**
 * One silent session refresh through the app's existing internal refresh flow
 * (src/app/internal-api/refresh/route.ts, same server-side cookie-refresh mechanism as
 * src/lib/serverBackendProxy.ts fetchBackendWithCookieRefresh). Never touches ABS auth state
 * on failure -- the caller surfaces the original gateway error instead.
 */
function silentSessionRefresh(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = fetch('/internal-api/refresh', {
      method: 'POST',
      credentials: 'include',
      headers: { accept: 'application/json' }
    })
      .then((response) => response.ok)
      .catch(() => false)
      .finally(() => {
        refreshInFlight = null
      })
  }
  return refreshInFlight
}

function withSessionRefreshRetry<Args extends unknown[], T>(fn: (...args: Args) => Promise<T>): (...args: Args) => Promise<T> {
  return async (...args: Args): Promise<T> => {
    try {
      return await fn(...args)
    } catch (error) {
      if (error instanceof AcquisitionApiError && error.status === 401 && (await silentSessionRefresh())) {
        return fn(...args)
      }
      throw error
    }
  }
}

const baseClient = createAcquisitionClient({ baseUrl: ACQUISITION_API_BASE_URL })

/** Browser client singleton. Same-origin HTTP-only ABS cookies authenticate every call. */
export const acquisitionClient = {
  status: withSessionRefreshRetry(baseClient.status),
  searchAudiobooks: withSessionRefreshRetry(baseClient.searchAudiobooks),
  createAcquisition: withSessionRefreshRetry(baseClient.createAcquisition),
  listAcquisitions: withSessionRefreshRetry(baseClient.listAcquisitions),
  getAcquisition: withSessionRefreshRetry(baseClient.getAcquisition),
  retryAcquisition: withSessionRefreshRetry(baseClient.retryAcquisition),
  cancelAcquisition: withSessionRefreshRetry(baseClient.cancelAcquisition)
}

const GATEWAY_ERROR_MESSAGE_KEYS: Record<string, TranslationKey> = {
  search_not_found: 'ErrorAcquisitionSearchExpired',
  search_expired: 'ErrorAcquisitionSearchExpired',
  release_not_found: 'ErrorAcquisitionReleaseNotFound',
  release_not_trackable: 'ErrorAcquisitionReleaseNotTrackable',
  library_forbidden: 'ErrorAcquisitionLibraryForbidden',
  library_mismatch: 'ErrorAcquisitionLibraryForbidden',
  acquisition_not_found: 'ErrorAcquisitionNotFound',
  acquisition_not_retryable: 'ErrorAcquisitionNotRetryable',
  acquisition_not_cancellable: 'ErrorAcquisitionNotCancellable',
  gateway_not_ready: 'ErrorAcquisitionGatewayNotReady'
}

/** Never echoes a raw upstream message verbatim into the UI -- maps known gateway codes to
 * translated copy and falls back to a generic message for anything unrecognized. */
export function formatAcquisitionError(error: unknown, t: TypeSafeTranslations): string {
  if (error instanceof AcquisitionApiError) {
    const key = GATEWAY_ERROR_MESSAGE_KEYS[error.code]
    if (key) return t(key)
  }
  return t('ErrorAcquisitionGatewayGeneric')
}
