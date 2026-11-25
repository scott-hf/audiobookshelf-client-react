import { useEffect, useState } from 'react'
import type { AbsClient } from '../api/absClient'
import { useAuth } from '../auth/AuthProvider'
import { buildOwnedIndex, type OwnedIndex } from '../lib/discoverBrowse'
import type { AbsLibraryItem } from '../types/abs'

/** Minimal shape this hook needs -- lets tests inject a fake without mocking a module. */
export type LibraryIndexApi = Pick<AbsClient, 'getLibraryItems'>

export type LibraryIndexStatus = 'loading' | 'ready' | 'error'

export interface UseLibraryIndexResult {
  /** Always usable: an empty index while loading or after a failure, so callers never null-check
   * (an empty index simply matches nothing, i.e. no "in library" badge). */
  index: OwnedIndex
  /** Every library book, newest first, de-duplicated by id. Empty while loading or after a failure. */
  items: AbsLibraryItem[]
  status: LibraryIndexStatus
}

/** Items per request. The real library is ~100 items (one minified page ~163 KB, ~90 ms). */
const PAGE_LIMIT = 500
/** Backstop against a server that never reports an end: 50 pages x 500 is far beyond any real library. */
const MAX_PAGES = 50
/** Long enough that tab switches and back-navigation reuse it, short enough that a freshly
 * acquired book becomes "in library" without restarting the app. */
const CACHE_TTL_MS = 5 * 60 * 1000

interface Loaded {
  items: AbsLibraryItem[]
  index: OwnedIndex
}

const EMPTY_ITEMS: AbsLibraryItem[] = []
const EMPTY_INDEX: OwnedIndex = buildOwnedIndex(EMPTY_ITEMS)

// The session has no account id, but a new login builds a new acquisition client (and every client
// is per server), so the client instance stands in for "server + account". WeakMap-keyed so the
// instance itself is never retained; ids are minted in increasing order, so a higher id is a newer
// client. The Discover hooks share this helper to make a replaced client part of their state keys.
const clientIds = new WeakMap<object, number>()
let nextClientId = 1
/** A small stable number for a client instance; 0 stands for "no client yet". */
export function clientInstanceId(owner: object | null | undefined): number {
  if (!owner) return 0
  let id = clientIds.get(owner)
  if (id === undefined) {
    id = nextClientId++
    clientIds.set(owner, id)
  }
  return id
}

const cache = new Map<string, { at: number; loaded: Loaded }>()
const inFlight = new Map<string, Promise<Loaded>>()

/** The session id a cache key belongs to: keys are `${sessionId}|${serverUrl}|${libraryId}`. */
function sessionOf(key: string): number {
  return Number(key.slice(0, key.indexOf('|')))
}

function fresh(key: string): Loaded | null {
  const hit = cache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key)
    return null
  }
  return hit.loaded
}

/**
 * Writes a finished walk into the cache. The map is strong and each entry is a whole library payload
 * (~163 KB), so it must not keep every past session's copy for the life of the process: writing for
 * a session drops every entry of a DIFFERENT session, and expired entries go with them (this is
 * where the TTL is enforced on write, not only when a mount looks an entry up).
 *
 * A walk that finishes for a session OLDER than one already cached (a replaced client whose request
 * was still out when the new session loaded) is not stored: it would evict the live session's entry
 * and keep the dead one. Its own callers still receive the result.
 */
function remember(key: string, loaded: Loaded): void {
  const mine = sessionOf(key)
  const now = Date.now()
  for (const other of cache.keys()) if (sessionOf(other) > mine) return
  for (const [other, entry] of cache) {
    if (sessionOf(other) !== mine || now - entry.at > CACHE_TTL_MS) cache.delete(other)
  }
  cache.set(key, { at: now, loaded })
}

/**
 * Deliberately takes no `AbortSignal`, even though `getLibraryItems` accepts one.
 *
 * This walk is shared: `load` keys it by server and library and hands the same promise to every
 * caller, so a signal belonging to whichever component happened to mount first would cancel the
 * index out from under all the others. Letting it finish is also cheap and not wasted -- the
 * measured library is 103 items over a single 163 KB page (93 ms), and the result is cached for
 * the next consumer. If this ever needs cancelling, it needs reference counting, not a signal.
 */
async function fetchAll(api: LibraryIndexApi, libraryId: string): Promise<Loaded> {
  const items: AbsLibraryItem[] = []
  const seen = new Set<string>()
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await api.getLibraryItems(libraryId, { page, limit: PAGE_LIMIT, minified: true, sort: 'addedAt', desc: true })
    if (response.results.length === 0) break
    let added = 0
    for (const item of response.results) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      items.push(item)
      added++
    }
    // A page that adds nothing new is not advancing (the server ignored `page`); stop instead of looping.
    if (added === 0) break
    if (items.length >= response.total) break
  }
  return { items, index: buildOwnedIndex(items) }
}

function load(api: LibraryIndexApi, key: string, libraryId: string): Promise<Loaded> {
  const existing = inFlight.get(key)
  if (existing) return existing
  const pending = fetchAll(api, libraryId).then((loaded) => {
    remember(key, loaded)
    return loaded
  })
  inFlight.set(key, pending)
  const release = () => {
    if (inFlight.get(key) === pending) inFlight.delete(key)
  }
  pending.then(release, release)
  return pending
}

interface State {
  key: string
  status: LibraryIndexStatus
  loaded: Loaded | null
}

/**
 * Loads EVERY item of a library (minified, newest first) and builds the owned-book index once, so
 * Discover cards can show "in server library" and For you can join listening history to genres.
 *
 * Cached per session + server + library for a few minutes (only the newest session's entries are
 * kept; see `remember`), with concurrent callers sharing one request. A failure is non-fatal and not cached: `status: 'error'` with an empty index, so browse
 * keeps working and cards simply get no badge.
 */
export function useLibraryIndex(libraryId: string | undefined): UseLibraryIndexResult {
  const { client, acquisitionClient, state: session } = useAuth()
  const api: LibraryIndexApi = client
  const key = libraryId ? `${clientInstanceId(acquisitionClient ?? client)}|${session.serverUrl ?? ''}|${libraryId}` : ''

  const [state, setState] = useState<State>(() => {
    const hit = key ? fresh(key) : null
    return hit ? { key, status: 'ready', loaded: hit } : { key, status: 'loading', loaded: null }
  })

  useEffect(() => {
    if (!libraryId || !key) {
      setState({ key, status: 'loading', loaded: null })
      return
    }
    const hit = fresh(key)
    if (hit) {
      setState({ key, status: 'ready', loaded: hit })
      return
    }
    let cancelled = false
    setState({ key, status: 'loading', loaded: null })
    load(api, key, libraryId).then(
      (loaded) => {
        if (!cancelled) setState({ key, status: 'ready', loaded })
      },
      (error: unknown) => {
        console.warn('Library index failed to load; Discover will not mark owned books', error)
        if (!cancelled) setState({ key, status: 'error', loaded: null })
      }
    )
    return () => {
      cancelled = true
    }
  }, [api, key, libraryId])

  // A state left over from another library (or session) must never be shown for this one.
  const view: State = state.key === key ? state : { key, status: 'loading', loaded: null }
  return { index: view.loaded?.index ?? EMPTY_INDEX, items: view.loaded?.items ?? EMPTY_ITEMS, status: view.status }
}
