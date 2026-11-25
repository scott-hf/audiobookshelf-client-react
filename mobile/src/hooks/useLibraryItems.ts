import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthProvider'
import type { AbsLibraryItem, GetLibraryItemsOptions } from '../types/abs'

export type LibraryItemsStatus = 'loading' | 'ready' | 'error'

export interface UseLibraryItemsResult {
  /** Every item loaded so far, in server order, de-duplicated by id. */
  items: AbsLibraryItem[]
  /** Match count across ALL pages; null until the first page lands. */
  total: number | null
  /** State of the FIRST page: 'loading' on mount and whenever `libraryId`/options change. */
  status: LibraryItemsStatus
  hasMore: boolean
  /** A follow-up page is in flight. */
  loadingMore: boolean
  /** The last follow-up page failed; `loadMore()` retries it. Already-loaded items stay shown. */
  loadMoreFailed: boolean
  /** Fetches the next page. No-op while one is in flight, when nothing remains, or before page 0. */
  loadMore: () => void
}

interface State {
  items: AbsLibraryItem[]
  total: number | null
  /** Pages fetched so far; also the index of the next page to fetch. */
  pagesLoaded: number
  /** The server returned an empty page before `total` was reached (items shifted under us). */
  exhausted: boolean
  status: LibraryItemsStatus
  loadingMore: boolean
  loadMoreFailed: boolean
}

const INITIAL: State = { items: [], total: null, pagesLoaded: 0, exhausted: false, status: 'loading', loadingMore: false, loadMoreFailed: false }

function appendUnique(existing: AbsLibraryItem[], incoming: AbsLibraryItem[]): AbsLibraryItem[] {
  // Items can shift between requests (a book added mid-scroll pushes the last row onto the next
  // page), so the same id can arrive twice; duplicate React keys would warn and mis-render.
  const seen = new Set(existing.map((item) => item.id))
  return [...existing, ...incoming.filter((item) => !seen.has(item.id))]
}

/**
 * Paginated `getLibraryItems`: loads page 0 on mount, then `loadMore()` appends further pages
 * until `total` is reached. Everything resets (and any in-flight request is discarded) when
 * `libraryId` or any option changes -- pass a fresh `options` object freely; identity doesn't matter,
 * only its contents. Do not pass `page` (the hook owns it).
 *
 * Pagination is explicit (`loadMore`) rather than scroll-driven so callers pick the trigger: a
 * "Load more" button today, an IntersectionObserver sentinel later, without touching this hook.
 */
export function useLibraryItems(libraryId: string | undefined, options: Omit<GetLibraryItemsOptions, 'page'> = {}): UseLibraryItemsResult {
  const { client } = useAuth()
  const [state, setState] = useState<State>(INITIAL)

  // Content-keyed so a caller passing an inline `{ sort: 'addedAt' }` doesn't refetch every render.
  const optionsKey = JSON.stringify(options)
  const optionsRef = useRef(options)
  optionsRef.current = options

  // Bumped on every reset; a response carrying an older value belongs to a query the user left.
  const generation = useRef(0)
  const stateRef = useRef(state)
  stateRef.current = state

  useEffect(() => {
    const mine = ++generation.current
    setState(INITIAL)
    if (!libraryId) return
    client
      .getLibraryItems(libraryId, { ...optionsRef.current, page: 0 })
      .then((response) => {
        if (generation.current !== mine) return
        setState({ items: appendUnique([], response.results), total: response.total, pagesLoaded: 1, exhausted: false, status: 'ready', loadingMore: false, loadMoreFailed: false })
      })
      .catch(() => {
        if (generation.current === mine) setState({ ...INITIAL, status: 'error' })
      })
    return () => {
      // Invalidate in cleanup too, so an unmount (not just a re-run) discards a late response.
      generation.current++
    }
  }, [client, libraryId, optionsKey])

  // Counted by items, not pages*limit: the server may clamp `limit`, so page math could stop early.
  const hasMore = state.total !== null && !state.exhausted && state.items.length < state.total

  const loadMore = useCallback(() => {
    const current = stateRef.current
    if (!libraryId || current.status !== 'ready' || current.loadingMore) return
    if (current.total === null || current.exhausted || current.items.length >= current.total) return
    const mine = generation.current
    const page = current.pagesLoaded
    // Flip the ref now, not just state: two calls in one tick (a double tap) would otherwise both
    // see loadingMore === false and fetch the same page twice.
    stateRef.current = { ...current, loadingMore: true, loadMoreFailed: false }
    setState((prev) => ({ ...prev, loadingMore: true, loadMoreFailed: false }))
    client
      .getLibraryItems(libraryId, { ...optionsRef.current, page })
      .then((response) => {
        if (generation.current !== mine) return
        setState((prev) => ({
          ...prev,
          items: appendUnique(prev.items, response.results),
          total: response.total,
          // An empty page means the server has nothing past here; stop instead of re-requesting it.
          pagesLoaded: prev.pagesLoaded + 1,
          exhausted: response.results.length === 0,
          loadingMore: false
        }))
      })
      .catch(() => {
        if (generation.current === mine) setState((prev) => ({ ...prev, loadingMore: false, loadMoreFailed: true }))
      })
  }, [client, libraryId])

  return {
    items: state.items,
    total: state.total,
    status: state.status,
    hasMore,
    loadingMore: state.loadingMore,
    loadMoreFailed: state.loadMoreFailed,
    loadMore
  }
}
