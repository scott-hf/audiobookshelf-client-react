import type { DiscoverItem } from '@abs/acquisition-contract'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { MobileAcquisitionClient } from '../api/acquisitionClient'
import { useAuth } from '../auth/AuthProvider'
import { cleanGenres, type ListenedBook, topGenres } from '../lib/discoverBrowse'
import { useUserProgress } from '../progress/UserProgressProvider'
import { clientInstanceId, useLibraryIndex } from './useLibraryIndex'

/** Minimal shape this hook needs -- lets tests inject a fake without mocking a module. */
export type ForYouApi = Pick<MobileAcquisitionClient, 'browseDiscover'>

export interface ForYouRow {
  genre: string
  items: DiscoverItem[]
  /** The gateway answered this genre in RELEVANCE order because the ranked catalog was unavailable
   * (`partial` on the response), so "Popular in {genre}" would not be true of this row. */
  partial: boolean
}

/**
 * - `loading`: waiting for the library, the listening history or the genre requests.
 * - `ready`: at least one row to show. `incomplete` says whether some other row failed.
 * - `empty`: nothing to recommend and NOTHING FAILED: no listening history that counts, or every
 *   genre came back with no books (see `reason`).
 * - `error`: nothing to show AND something failed (library, progress, or a genre request -- including
 *   one the server rejected as `invalid_request`, which is a broken request, not a quiet genre). Never
 *   the same state as `empty`, so "you have no history" is not shown for an outage.
 */
export type ForYouStatus = 'loading' | 'ready' | 'empty' | 'error'

export interface UseForYouResult {
  rows: ForYouRow[]
  status: ForYouStatus
  /** Some genre request failed while others succeeded: the rows shown are real but not the full set. */
  incomplete: boolean
  /**
   * Why `status` is `'empty'`; `null` whenever it is not.
   * - `'no-history'`: the listener had no usable genre at all.
   * - `'no-results'`: they did, but nothing came back for those genres (and nothing failed).
   *
   * `status: 'empty'` covers two different situations and they deserve different words: nobody
   * has listened to anything yet, versus they have but the upstream had nothing to suggest for
   * those genres. Telling a listener "listen to a few books and suggestions will show up" when
   * they already have is simply wrong, and on this library it is the likely case -- half the
   * books carry no genre but "Audiobook", which is discarded as noise.
   */
  reason: 'no-history' | 'no-results' | null
}

/** Librarr's discover rate-limit bucket (60/min) is shared with every Browse tap, so go gently. */
const CONCURRENCY = 2
const ROW_SIZE = 12
const CATALOG = 'popular'

interface Result {
  key: string
  rows: ForYouRow[]
  status: ForYouStatus
  incomplete: boolean
}

/** `failed` is a request that threw OR one the server rejected (`invalid_request`); a genre with no
 * books is a successful answer with no items. */
type Outcome = { items: DiscoverItem[]; partial: boolean } | 'failed'

function buildResult(key: string, genres: string[], outcomes: (Outcome | null)[]): Result {
  const seen = new Set<string>()
  const rows: ForYouRow[] = []
  let failed = false
  genres.forEach((genre, i) => {
    const outcome = outcomes[i]
    if (outcome === 'failed') {
      failed = true
      return
    }
    if (!outcome) return
    // Dedupe against the rows already built, THEN cut to the row size, so an overlap with an earlier
    // genre costs that book its slot but does not leave this row short of distinct books.
    const items: DiscoverItem[] = []
    for (const item of outcome.items) {
      if (seen.has(item.key)) continue
      seen.add(item.key)
      items.push(item)
      if (items.length >= ROW_SIZE) break
    }
    // A genre with no books is dropped quietly; it is not a failure.
    if (items.length > 0) rows.push({ genre, items, partial: outcome.partial })
  })
  if (rows.length > 0) return { key, rows, status: 'ready', incomplete: failed }
  return { key, rows: [], status: failed ? 'error' : 'empty', incomplete: false }
}

/**
 * "For you" rows: the listener's top genres (from `/api/me` progress joined to the library) each
 * become a row of Open Library's popular books in that genre.
 *
 * Mixed failures are kept apart: a row that fails flags `incomplete` while the rows that worked are
 * still shown; `error` is reserved for "nothing to show and something failed".
 */
export function useForYou(libraryId: string | undefined): UseForYouResult {
  const { acquisitionClient } = useAuth()
  const api: ForYouApi | null = acquisitionClient
  const progress = useUserProgress()
  const library = useLibraryIndex(libraryId)

  const genres = useMemo(() => {
    const byId = new Map(library.items.map((item) => [item.id, item]))
    const history: ListenedBook[] = []
    for (const entry of progress.progressMap.values()) {
      // Podcast episodes carry an episodeId; the type check also covers servers that tag them.
      if (entry.episodeId) continue
      const mediaItemType = (entry as { mediaItemType?: string }).mediaItemType
      if (mediaItemType !== undefined && mediaItemType !== 'book') continue
      const item = byId.get(entry.libraryItemId)
      if (!item) continue
      history.push({
        id: item.id,
        title: item.media.metadata.title,
        author: item.media.metadata.authorName ?? '',
        genres: cleanGenres(item.media.metadata.genres),
        currentTimeSec: entry.currentTime,
        durationSec: entry.duration > 0 ? entry.duration : (item.media.duration ?? 0),
        isFinished: entry.isFinished,
        lastUpdate: entry.lastUpdate ?? 0
      })
    }
    return topGenres(history)
  }, [library.items, progress.progressMap])

  // The client instance is part of the key a result is valid for: after a re-login or server change
  // the same genres must not be handed the previous client's rows for the render before the effect resets.
  const genresKey = `${clientInstanceId(acquisitionClient)}|${genres.join('\u0000')}`
  const genresRef = useRef(genres)
  genresRef.current = genres

  const inputsReady = !!api && progress.status !== 'loading' && library.status === 'ready'
  const [result, setResult] = useState<Result | null>(null)

  useEffect(() => {
    // A result is only valid for the client/inputs that produced it.
    setResult(null)
    if (!api || !inputsReady || genresRef.current.length === 0) return
    const wanted = genresRef.current
    const controller = new AbortController()
    let cancelled = false
    const outcomes: (Outcome | null)[] = wanted.map(() => null)
    let cursor = 0

    const worker = async () => {
      while (!cancelled) {
        const i = cursor++
        const genre = wanted[i]
        if (genre === undefined) return
        try {
          const response = await api.browseDiscover({ catalog: CATALOG, genre, offset: 0 }, { signal: controller.signal })
          // `invalid_request` is a request the server REJECTED, not a genre without books: folding
          // it into 'empty' would hide a broken request and tell the listener their history is the
          // problem. Only `empty` drops quietly.
          if (response.status === 'invalid_request') outcomes[i] = 'failed'
          else outcomes[i] = { items: response.status === 'ok' ? response.items : [], partial: response.partial }
        } catch {
          outcomes[i] = 'failed'
        }
      }
    }

    void Promise.all(Array.from({ length: Math.min(CONCURRENCY, wanted.length) }, worker)).then(() => {
      if (!cancelled) setResult(buildResult(genresKey, wanted, outcomes))
    })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [api, inputsReady, genresKey])

  const loading: UseForYouResult = { rows: [], status: 'loading', incomplete: false, reason: null }
  if (!api || !libraryId) return loading
  if (progress.status === 'loading' || library.status === 'loading') return loading
  // Progress or the library failing means "no history" would be a guess, not a finding.
  if (library.status === 'error' || (progress.status === 'error' && progress.progressMap.size === 0))
    return { rows: [], status: 'error', incomplete: false, reason: null }
  if (genres.length === 0) return { rows: [], status: 'empty', incomplete: false, reason: 'no-history' }
  if (result && result.key === genresKey)
    return { rows: result.rows, status: result.status, incomplete: result.incomplete, reason: result.status === 'empty' ? 'no-results' : null }
  return loading
}
