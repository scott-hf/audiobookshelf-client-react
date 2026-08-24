import { createContext, ReactNode, useContext, useEffect, useMemo, useState } from 'react'
import { type AbsClient, createAbsClient } from '../api/absClient'
import { createMobileAcquisitionClient, type MobileAcquisitionClient } from '../api/acquisitionClient'
import { secureVault } from '../native/secureSession'
import { SessionState, SessionStore } from './session'

export interface AuthContextValue {
  state: SessionState
  client: AbsClient
  /** Non-null only once state.status === 'authenticated' -- routes that need it (Discover,
   * AcquisitionQueue) only ever mount inside AuthenticatedApp, so a non-null assertion at the
   * call site is safe there. */
  acquisitionClient: MobileAcquisitionClient | null
  login: (serverUrl: string, username: string, password: string) => Promise<void>
  logout: () => Promise<void>
}

/** Exported so tests can render routes with `<AuthContext.Provider value={...}>` instead of
 * standing up the real Capacitor-backed AuthProvider. */
export const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const session = useMemo(() => new SessionStore({ vault: secureVault }), [])
  const client = useMemo(() => createAbsClient({ session }), [session])
  const [state, setState] = useState<SessionState>({ status: 'unknown', serverUrl: null })

  useEffect(() => {
    const unsubscribe = session.subscribe(setState)
    session.restore()
    return unsubscribe
  }, [session])

  const acquisitionClient = useMemo(() => (state.status === 'authenticated' ? createMobileAcquisitionClient(session) : null), [session, state.status])

  const value = useMemo<AuthContextValue>(
    () => ({
      state,
      client,
      acquisitionClient,
      login: (serverUrl, username, password) => session.login(serverUrl, username, password),
      logout: () => session.logout()
    }),
    [state, client, acquisitionClient, session]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext)
  if (!value) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return value
}
