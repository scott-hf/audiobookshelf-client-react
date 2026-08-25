import type { GetLibraryItemsResponse, AbsLibrary, AbsLibraryItem, AbsPlaybackSession, GetLibrariesResponse } from '../types/abs'
import type { SessionStore } from '../auth/session'

export class AbsApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
  }
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

  async function request<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
    const serverUrl = session.getServerUrl()
    const accessToken = session.getAccessToken()
    if (!serverUrl || !accessToken) {
      throw new AbsApiError(401, 'Not authenticated')
    }

    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${accessToken}`)

    const response = await fetcher(`${serverUrl}${path}`, { ...init, headers })

    if (response.status === 401 && !retried) {
      const refreshed = await session.refresh()
      if (refreshed) {
        return request<T>(path, init, true)
      }
    }

    if (!response.ok) {
      const message = await response.text().catch(() => response.statusText)
      throw new AbsApiError(response.status, message || response.statusText)
    }

    return (await response.json()) as T
  }

  return {
    getLibraries: () => request<GetLibrariesResponse>('/api/libraries'),

    getLibraryItems: (libraryId: string, page = 0) =>
      request<GetLibraryItemsResponse>(`/api/libraries/${encodeURIComponent(libraryId)}/items?limit=30&page=${page}&sort=media.metadata.title`),

    getLibraryItem: (itemId: string) => request<AbsLibraryItem>(`/api/items/${encodeURIComponent(itemId)}?expanded=1&include=progress`),

    startSession: (itemId: string, options: StartSessionOptions) =>
      request<AbsPlaybackSession>(`/api/items/${encodeURIComponent(itemId)}/play`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(options)
      }),

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
