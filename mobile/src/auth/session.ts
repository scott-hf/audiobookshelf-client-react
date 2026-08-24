import type { SessionVault, StoredSession } from './vault'

export type SessionStatus = 'unknown' | 'authenticated' | 'unauthenticated'

export interface SessionState {
  status: SessionStatus
  serverUrl: string | null
}

export type SessionListener = (state: SessionState) => void

export class AbsAuthError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
  }
}

/** Accepts a bare host or a full URL; always returns `scheme://host[:port]/path` with no
 * trailing slash. Defaults to https when no scheme is given. */
export function normalizeServerUrl(value: string): string {
  const trimmed = value.trim()
  const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`)
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.toString().replace(/\/$/, '')
}

async function checkedJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const message = await response.text().catch(() => response.statusText)
    throw new AbsAuthError(response.status, message || response.statusText)
  }
  return (await response.json()) as T
}

interface AbsLoginResponse {
  user: {
    accessToken?: string
    refreshToken?: string
  }
}

interface AbsRefreshResponse {
  user: {
    accessToken: string
    refreshToken?: string
  }
}

export interface SessionDeps {
  vault: SessionVault
  fetcher?: typeof fetch
}

/**
 * Owns the current ABS session (server URL + tokens), persists it through the injected
 * vault (production: AndroidX Security encrypted SharedPreferences via native/secureSession.ts;
 * tokens are NEVER written to React-side storage or logged), and does the one-retry silent
 * refresh on 401 -- same pattern as the web app's fetchBackendWithCookieRefresh
 * (src/lib/serverBackendProxy.ts), ported to a bearer-token client instead of cookies.
 */
export class SessionStore {
  private readonly fetcher: typeof fetch
  private readonly vault: SessionVault
  private current: StoredSession | null = null
  private readonly listeners = new Set<SessionListener>()

  constructor(deps: SessionDeps) {
    // Must be bound to globalThis, not stored as a bare reference: fetch is a native
    // WebIDL global-scope-mixin operation, and calling it later as `this.fetcher(...)`
    // (a method-call, receiver = this SessionStore instance) throws
    // "TypeError: Failed to execute 'fetch' on 'Window': Illegal invocation" in real
    // browsers -- the brand check only tolerates a null/undefined receiver (a bare
    // detached call), not an arbitrary unrelated object. This threw synchronously
    // before any request was ever sent, which is exactly why the Playwright e2e login
    // step saw zero network activity: vitest unit tests never caught it because they
    // always inject a mocked `fetcher`, never exercising the `?? fetch` default.
    this.fetcher = deps.fetcher ?? fetch.bind(globalThis)
    this.vault = deps.vault
  }

  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit() {
    const state = this.getState()
    for (const listener of this.listeners) listener(state)
  }

  getState(): SessionState {
    return { status: this.current ? 'authenticated' : 'unauthenticated', serverUrl: this.current?.serverUrl ?? null }
  }

  getServerUrl(): string | null {
    return this.current?.serverUrl ?? null
  }

  getAccessToken(): string | null {
    return this.current?.accessToken ?? null
  }

  /** Loads any previously-persisted session from the vault. Call once on app start. */
  async restore(): Promise<SessionState> {
    const stored = await this.vault.read()
    this.current = stored
    this.emit()
    return this.getState()
  }

  async login(serverUrlInput: string, username: string, password: string): Promise<void> {
    const serverUrl = normalizeServerUrl(serverUrlInput)
    const response = await this.fetcher(`${serverUrl}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-return-tokens': 'true' },
      body: JSON.stringify({ username, password })
    })
    const data = await checkedJson<AbsLoginResponse>(response)
    if (!data.user.accessToken || !data.user.refreshToken) {
      throw new AbsAuthError(500, 'Server did not return session tokens')
    }
    await this.persist({ serverUrl, accessToken: data.user.accessToken, refreshToken: data.user.refreshToken })
  }

  async logout(): Promise<void> {
    this.current = null
    await this.vault.clear()
    this.emit()
  }

  private async persist(session: StoredSession): Promise<void> {
    this.current = session
    await this.vault.write(session)
    this.emit()
  }

  /** One silent refresh attempt. Never throws -- callers treat a `false` return as "the
   * caller's original 401 stands", matching the web app's refresh-then-retry-once contract. */
  async refresh(): Promise<boolean> {
    if (!this.current) return false
    const { serverUrl, refreshToken } = this.current
    try {
      const response = await this.fetcher(`${serverUrl}/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-refresh-token': refreshToken }
      })
      if (!response.ok) return false
      const data = await checkedJson<AbsRefreshResponse>(response)
      await this.persist({
        serverUrl,
        accessToken: data.user.accessToken,
        refreshToken: data.user.refreshToken ?? refreshToken
      })
      return true
    } catch {
      return false
    }
  }
}
