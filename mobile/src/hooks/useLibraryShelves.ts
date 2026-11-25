import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthProvider'
import type { AbsShelf } from '../types/abs'

export type LibraryShelvesStatus = 'loading' | 'ready' | 'error'

export interface UseLibraryShelvesResult {
  /** Shelves exactly as the server sent them (unordered, unfiltered); null until the first fetch
   * succeeds. A failed refresh keeps the previous shelves so the page never blanks. */
  shelves: AbsShelf[] | null
  /** 'loading' until the first fetch settles; 'error' when the latest attempt failed (check
   * `shelves` to tell a first-load failure from a failed refresh). */
  status: LibraryShelvesStatus
  /** A manual `refresh()` is in flight. */
  refreshing: boolean
  /** Re-fetches the shelves. Mobile has no sockets (the web client re-fetches on socket events),
   * so this is the only way to pick up changes besides re-opening the page. */
  refresh: () => void
}

interface State {
  shelves: AbsShelf[] | null
  status: LibraryShelvesStatus
  refreshing: boolean
}

const INITIAL: State = { shelves: null, status: 'loading', refreshing: false }

/**
 * Loads `GET /api/libraries/:id/personalized` on mount and whenever `libraryId` (or the client,
 * i.e. a new session) changes. Any in-flight request is aborted when a newer one starts or the
 * page unmounts, so a slow response for a previous library can never overwrite the current one.
 */
export function useLibraryShelves(libraryId: string | undefined): UseLibraryShelvesResult {
  const { client } = useAuth()
  const [state, setState] = useState<State>(INITIAL)
  const controllerRef = useRef<AbortController | null>(null)

  const load = useCallback(
    (keepExisting: boolean) => {
      if (!libraryId) return
      controllerRef.current?.abort()
      const controller = new AbortController()
      controllerRef.current = controller
      setState((previous) => (keepExisting ? { ...previous, refreshing: true } : INITIAL))
      client
        .getLibraryPersonalized(libraryId, undefined, controller.signal)
        .then((shelves) => {
          if (controller.signal.aborted) return
          // Tolerate a non-array body: an odd response should render as "no shelves", not crash.
          setState({ shelves: Array.isArray(shelves) ? shelves : [], status: 'ready', refreshing: false })
        })
        .catch(() => {
          if (controller.signal.aborted) return
          setState((previous) => ({ ...previous, status: 'error', refreshing: false }))
        })
    },
    [client, libraryId]
  )

  useEffect(() => {
    load(false)
    return () => controllerRef.current?.abort()
  }, [load])

  const refresh = useCallback(() => load(true), [load])

  return { ...state, refresh }
}
