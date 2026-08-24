/** One persisted ABS session: server + both tokens. Never written anywhere except a
 * SessionVault implementation -- see native/secureSession.ts for the production (Android
 * encrypted SharedPreferences) implementation. */
export interface StoredSession {
  serverUrl: string
  accessToken: string
  refreshToken: string
}

export interface SessionVault {
  read(): Promise<StoredSession | null>
  write(session: StoredSession): Promise<void>
  clear(): Promise<void>
}
