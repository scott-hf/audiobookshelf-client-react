import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { buildProgressMap, EMPTY_PROGRESS_MAP, getProgress as lookupProgress, type UserProgressMap } from '../api/progressMap'
import { useAuth } from '../auth/AuthProvider'
import type { AbsUserMediaProgress } from '../types/abs'

export type UserProgressStatus = 'loading' | 'ready' | 'error'

export interface UserProgressContextValue {
  /** Progress rows keyed by library item id (book) or `<itemId>-<episodeId>` (episode). Empty
   * until the first fetch lands and after a failed first fetch; a later failed refresh keeps the
   * previous map rather than blanking every progress bar. */
  progressMap: UserProgressMap
  /** Progress for a book (omit `episodeId`) or episode; undefined when never started. */
  getProgress: (libraryItemId: string, episodeId?: string | null) => AbsUserMediaProgress | undefined
  /** 'loading' until the first fetch settles; 'error' only if the latest attempt failed. */
  status: UserProgressStatus
  /** Re-fetches `/api/me`. Concurrent calls share one request. Resolves (never rejects) once the
   * fetch settles; failure surfaces as `status === 'error'`. Call it when returning from the
   * player so progress made there shows up. */
  refresh: () => Promise<void>
}

export const UserProgressContext = createContext<UserProgressContextValue | undefined>(undefined)

/**
 * Owns the per-user progress map for list screens, mirroring `DownloadProvider`'s "context owns
 * the live state, pages just read it" shape. Fetches `/api/me` once on mount (and again if the
 * client instance changes, i.e. a new session) and refreshes on demand -- there is deliberately no
 * polling, since progress only moves while this device is playing and the player's own sync keeps
 * the server current.
 */
export function UserProgressProvider({ children }: { children: ReactNode }) {
  const { client } = useAuth()
  const [progressMap, setProgressMap] = useState<UserProgressMap>(EMPTY_PROGRESS_MAP)
  const [status, setStatus] = useState<UserProgressStatus>('loading')
  const inFlight = useRef<Promise<void> | null>(null)
  const mounted = useRef(true)
  const currentClient = useRef(client)
  currentClient.current = client

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const refresh = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current
    const pending = client
      .getMe()
      .then((user) => {
        // A response for a replaced client belongs to the previous session/user.
        if (!mounted.current || currentClient.current !== client) return
        setProgressMap(buildProgressMap(user.mediaProgress))
        setStatus('ready')
      })
      .catch(() => {
        // Keep whatever map we had; progress bars are decoration and must never break a screen.
        if (mounted.current && currentClient.current === client) setStatus('error')
      })
      .finally(() => {
        if (inFlight.current === pending) inFlight.current = null
      })
    inFlight.current = pending
    return pending
  }, [client])

  useEffect(() => {
    // A different client means a different session/user: drop the old user's progress first.
    setProgressMap(EMPTY_PROGRESS_MAP)
    setStatus('loading')
    inFlight.current = null
    void refresh()
  }, [refresh])

  const getProgress = useCallback((libraryItemId: string, episodeId?: string | null) => lookupProgress(progressMap, libraryItemId, episodeId), [progressMap])

  const value = useMemo<UserProgressContextValue>(() => ({ progressMap, getProgress, status, refresh }), [progressMap, getProgress, status, refresh])

  return <UserProgressContext.Provider value={value}>{children}</UserProgressContext.Provider>
}

export function useUserProgress(): UserProgressContextValue {
  const value = useContext(UserProgressContext)
  if (!value) {
    throw new Error('useUserProgress must be used within a UserProgressProvider')
  }
  return value
}
