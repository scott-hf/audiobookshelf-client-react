import type { DiscoverBrowseResponse, DiscoverItem } from '@abs/acquisition-contract'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MobileAcquisitionClient } from '../api/acquisitionClient'
import { useAuth } from '../auth/AuthProvider'
import { type BrowseSelection, GENRE_ALL_ID, mergeCards } from '../lib/discoverBrowse'
import { clientInstanceId } from './useLibraryIndex'

/** Minimal shape this hook needs -- lets tests inject a fake without mocking a module. */
export type DiscoverBrowseApi = Pick<MobileAcquisitionClient, 'browseDiscover'>

/**
 * State of the FIRST page:
 * - `loading`: out on the wire. Browse measured 0.2-11.7 s (Open Library stalls past 35 s), so this
 *   can legitimately last a while -- the page must make that look alive.
 * - `ready`: at least one card, or a short/blank page with more still to come (`hasMore`).
 * - `empty`: the catalog answered and there is nowhere left to go: no cards AND no forward cursor.
 *   NOT a failure. A blank first page that still carries a usable cursor is `ready` (with
 *   `hasMore`), whatever the response `status` says, so a live cursor is never thrown away.
 * - `invalid`: the catalog answered `invalid_request` -- the list is no longer offered.
 * - `error`: the request itself failed (outage, rate limit, timeout). See `errorCode`.
 *
 * `empty`, `invalid` and `error` are three different things and never collapse into one.
 */
export type DiscoverBrowseStatus = 'loading' | 'ready' | 'empty' | 'error' | 'invalid'

/** `errorCode` for a follow-up page the catalog answered `invalid_request` (not a gateway error code;
 * minted here because that answer is a 200 body, not a thrown error). */
export const DISCOVER_INVALID_SELECTION = 'discover_invalid_selection'

export interface UseDiscoverBrowseResult {
  items: DiscoverItem[]
  status: DiscoverBrowseStatus
  /** The cursor the next page will be requested at; `null` is the ONLY end-of-paging signal. */
  nextOffset: number | null
  /** `nextOffset !== null`. A short page is not the last page (a real page came back with 7 items
   * and `nextOffset` still 20), so this is never inferred from `items.length`. */
  hasMore: boolean
  loadingMore: boolean
  /** The last follow-up page failed. Loaded cards stay; `loadMore()`/`retry()` resume at the failed
   * cursor -- except when the server REJECTED that cursor (`errorCode` {@link DISCOVER_INVALID_SELECTION}):
   * re-sending it would fail the same way forever, so the cursor is dropped (`hasMore` false) and
   * there is nothing left to retry. */
  loadMoreFailed: boolean
  /** Ranked catalog fell back to relevance order on some page: the order is not meaningful. */
  partial: boolean
  /** Gateway error code of the failure behind `status === 'error'` or `loadMoreFailed`
   * (`discover_upstream_unavailable`, `discover_rate_limited`, ...; {@link DISCOVER_INVALID_SELECTION}
   * for a follow-up page answered `invalid_request`); null when unknown or no failure. */
  errorCode: string | null
  /** Requests the next page. No-op while one is in flight, when `nextOffset` is null, or before page 0 lands. */
  loadMore: () => void
  /** Retries whatever failed: the first page (`status === 'error'`) or the follow-up page. */
  retry: () => void
}

interface State {
  /** Which client + selection this state belongs to; a state for another key is never shown. */
  key: string
  items: DiscoverItem[]
  status: DiscoverBrowseStatus
  nextOffset: number | null
  partial: boolean
  loadingMore: boolean
  loadMoreFailed: boolean
  errorCode: string | null
}

function initialState(key: string, active: boolean): State {
  return { key, items: [], status: active ? 'loading' : 'empty', nextOffset: null, partial: false, loadingMore: false, loadMoreFailed: false, errorCode: null }
}

function codeOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  const { code } = error as { code?: unknown }
  return typeof code === 'string' ? code : null
}

/** A cursor that does not move forward would make `loadMore` re-request the same page forever. */
function safeNext(next: number | null, requested: number): number | null {
  return next !== null && next > requested ? next : null
}

/**
 * Pages one Open Library catalog (optionally narrowed to a genre) through the gateway.
 *
 * Only `kind: 'catalog'` selections fetch; a `forYou` selection leaves the hook idle (`status:
 * 'empty'`, no request), since For you is built by `useForYou`.
 *
 * Structure follows `useLibraryItems`: a `generation` bumped on every selection change and unmount,
 * and a `stateRef` flipped synchronously so a double tap cannot fire two requests. Every response,
 * success or failure, is checked against its generation before it touches state, and the
 * superseded request is aborted.
 */
export function useDiscoverBrowse(selection: BrowseSelection): UseDiscoverBrowseResult {
  const { acquisitionClient } = useAuth()
  const api: DiscoverBrowseApi | null = acquisitionClient

  const catalogId = selection.kind === 'catalog' ? selection.catalogId : null
  // "All genres" is a client sentinel and must never reach the gateway as a genre.
  const genre = selection.kind === 'catalog' && selection.genreId && selection.genreId !== GENRE_ALL_ID ? selection.genreId : undefined
  // The client instance is part of the key: after a re-login or server change the same selection
  // must not be handed the previous client's cards or cursor for the render before the effect resets.
  const key = catalogId === null ? '' : `${clientInstanceId(acquisitionClient)}\u0000${catalogId}\u0000${genre ?? ''}`
  const active = catalogId !== null

  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<State>(() => initialState(key, active))
  const stateRef = useRef(state)
  const generation = useRef(0)
  const controllerRef = useRef<AbortController | null>(null)

  const commit = useCallback((next: State) => {
    stateRef.current = next
    setState(next)
  }, [])

  const requestPage = useCallback(
    async (mine: number, offset: number, first: boolean) => {
      if (!api || catalogId === null) return
      const controller = new AbortController()
      controllerRef.current = controller
      const params: { catalog: string; genre?: string; offset: number } = { catalog: catalogId, offset }
      if (genre) params.genre = genre
      try {
        const response: DiscoverBrowseResponse = await api.browseDiscover(params, { signal: controller.signal })
        if (generation.current !== mine) return
        const prev = stateRef.current
        if (response.status === 'invalid_request') {
          // A later page the catalog rejects is rejected for good: keep the cards, but DROP the cursor
          // (`loadMore` bails on a null `nextOffset`, and `retry` only ever calls `loadMore` here),
          // so a Retry can never re-send the identical rejected request.
          commit(
            first
              ? { ...prev, status: 'invalid', items: [], nextOffset: null, loadingMore: false, errorCode: null }
              : { ...prev, nextOffset: null, loadingMore: false, loadMoreFailed: true, errorCode: DISCOVER_INVALID_SELECTION }
          )
          return
        }
        const items = mergeCards(first ? [] : prev.items, response.items)
        const nextOffset = safeNext(response.nextOffset, offset)
        // End the shelf only when there is genuinely nowhere to go. A blank first page that still
        // carries a forward cursor (whatever its `status`) stays `ready` so Load more is offered.
        if (first && items.length === 0 && nextOffset === null) {
          commit({ ...prev, status: 'empty', items: [], nextOffset: null, partial: false, loadingMore: false, loadMoreFailed: false, errorCode: null })
          return
        }
        commit({
          ...prev,
          status: 'ready',
          items,
          nextOffset,
          partial: (first ? false : prev.partial) || response.partial,
          loadingMore: false,
          loadMoreFailed: false,
          errorCode: null
        })
      } catch (error) {
        // A superseded or aborted request must not surface as a failure of the newer one.
        if (generation.current !== mine) return
        const prev = stateRef.current
        commit(first ? { ...prev, status: 'error', items: [], nextOffset: null, loadingMore: false, errorCode: codeOf(error) } : { ...prev, loadingMore: false, loadMoreFailed: true, errorCode: codeOf(error) })
      } finally {
        // Release only what is still mine: a late `finally` from a superseded request must not null
        // out the controller (or any flag) of the request that replaced it.
        if (controllerRef.current === controller) controllerRef.current = null
      }
    },
    [api, catalogId, genre, commit]
  )

  useEffect(() => {
    const mine = ++generation.current
    controllerRef.current?.abort()
    controllerRef.current = null
    commit(initialState(key, active))
    if (api && active) void requestPage(mine, 0, true)
    return () => {
      // Bump in cleanup too, so an unmount (not just a selection change) discards a late response.
      generation.current++
      controllerRef.current?.abort()
      controllerRef.current = null
    }
  }, [api, key, active, attempt, requestPage, commit])

  const loadMore = useCallback(() => {
    const current = stateRef.current
    if (!api || !active || current.key !== key) return
    if (current.status !== 'ready' || current.loadingMore || current.nextOffset === null) return
    // Take the guard NOW, before anything is awaited: a double tap in one tick must see it.
    commit({ ...current, loadingMore: true, loadMoreFailed: false, errorCode: null })
    void requestPage(generation.current, current.nextOffset, false)
  }, [api, active, key, requestPage, commit])

  const retry = useCallback(() => {
    const current = stateRef.current
    if (current.key !== key) return
    if (current.status === 'error') setAttempt((n) => n + 1)
    else if (current.loadMoreFailed) loadMore()
  }, [key, loadMore])

  // Between a selection change and the effect that resets state, show the new selection's loading
  // state rather than the previous selection's cards.
  const view = state.key === key ? state : initialState(key, active)

  return {
    items: view.items,
    status: view.status,
    nextOffset: view.nextOffset,
    hasMore: view.nextOffset !== null,
    loadingMore: view.loadingMore,
    loadMoreFailed: view.loadMoreFailed,
    partial: view.partial,
    errorCode: view.errorCode,
    loadMore,
    retry
  }
}
