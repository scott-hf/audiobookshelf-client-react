import { useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthProvider'
import type { AbsFilterData } from '../types/abs'

export type LibraryFilterDataStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface UseLibraryFilterDataResult {
  /** Null until loaded (and for a library other than the one that was loaded). */
  filterData: AbsFilterData | null
  status: LibraryFilterDataStatus
  /** Re-attempts after an error. */
  retry: () => void
}

/**
 * Lazy `GET /api/libraries/:id/filterdata`. Nothing is fetched until `enabled` first turns true
 * (the filter sheet opening), so browsing the list never pays for a request most visits don't use;
 * once loaded it is kept for the life of the screen, so reopening the sheet is instant.
 *
 * The server caches this response for ~30 minutes: treat the lists as a hint, not as the truth.
 */
export function useLibraryFilterData(libraryId: string | undefined, enabled: boolean): UseLibraryFilterDataResult {
  const { client } = useAuth()
  const [loaded, setLoaded] = useState<{ libraryId: string; data: AbsFilterData } | null>(null)
  const [status, setStatus] = useState<LibraryFilterDataStatus>('idle')
  const [attempt, setAttempt] = useState(0)
  const haveData = loaded !== null && loaded.libraryId === libraryId

  useEffect(() => {
    if (!libraryId || !enabled || haveData) return
    const controller = new AbortController()
    setStatus('loading')
    client
      .getFilterData(libraryId, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return
        setLoaded({ libraryId, data })
        setStatus('ready')
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus('error')
      })
    return () => controller.abort()
  }, [client, libraryId, enabled, haveData, attempt])

  return {
    filterData: haveData ? loaded.data : null,
    status: haveData ? 'ready' : status,
    retry: () => setAttempt((count) => count + 1)
  }
}
