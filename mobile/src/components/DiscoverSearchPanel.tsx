import type { SearchRelease, SearchResponse } from '@abs/acquisition-contract'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { formatAcquisitionError, type MobileAcquisitionClient } from '../api/acquisitionClient'
import { useAcquisition } from '../contexts/AcquisitionContext'
import { useTypeSafeTranslations } from '../hooks/useTypeSafeTranslations'
import ConfirmDialog from './ConfirmDialog'
import LoadingView from './LoadingView'
import ReleaseCard from './ReleaseCard'
import Btn from './ui/Btn'
import PageMessage from './ui/PageMessage'
import TextInput from './ui/TextInput'

/** Minimal shape this panel needs -- lets tests inject a fake implementation via AuthContext
 * without mocking the module import (mirrors the web app's DiscoverApi contract). */
export type DiscoverSearchApi = Pick<MobileAcquisitionClient, 'searchAudiobooks' | 'createAcquisition'>

interface DiscoverSearchPanelProps {
  libraryId: string
  api: DiscoverSearchApi
  /** Seed for the search box. A Browse card hands over "<title> <author>" so the user does not
   * retype what they just tapped. */
  initialQuery?: string
  /** Run the search immediately on mount for the seeded query. Only set by a Browse card tap --
   * a plain visit to the Search tab must not fire a ~30s indexer fan-out unasked. */
  autoSearch?: boolean
  /** Called once an auto-search has been consumed, so returning to this panel later does not
   * re-run it. */
  onAutoSearchConsumed?: () => void
  /** Reports every edit to the owner, which holds the draft. Switching to the Browse tab
   * unmounts this panel, so a query kept only in local state here would be lost. */
  onQueryChange?: (value: string) => void
}

/**
 * The acquisition search: type a title, Librarr fans out to the indexers, pick a release, the
 * server fetches it into its own library.
 *
 * This is the original `DiscoverPage` body, moved verbatim so the Browse tab could be added
 * beside it without putting the two flows in one component. Behaviour here is deliberately
 * unchanged -- the elapsed counter, the blur-on-submit keyboard fix and the abort-on-unmount
 * were all found on a real device and are load-bearing. See the comments below before touching
 * them.
 */
export default function DiscoverSearchPanel({
  libraryId,
  api,
  initialQuery = '',
  autoSearch = false,
  onAutoSearchConsumed,
  onQueryChange
}: DiscoverSearchPanelProps) {
  const t = useTypeSafeTranslations()
  const navigate = useNavigate()
  const { applyAcquisition } = useAcquisition()

  const [query, setQuery] = useState(initialQuery)
  /** Keep the owner's copy in step: it is what survives this panel being unmounted by a tab
   * switch. Local state stays too, so typing is not a round trip through the parent. */
  const editQuery = (value: string) => {
    setQuery(value)
    onQueryChange?.(value)
  }
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searchResult, setSearchResult] = useState<SearchResponse | null>(null)
  const [selected, setSelected] = useState<SearchRelease | null>(null)
  const [submitting, setSubmitting] = useState(false)
  // A gateway search fans out to external indexers through Librarr and measurably takes ~30s on
  // this server. A single static "Searching…" for that long reads as a hung app, so the wait is
  // given an elapsed counter, an explanation, and a way out. See MessageMobileSearchingSlowHint.
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const abortRef = useRef<AbortController | null>(null)
  // `handleSearch` is recreated every render, so the auto-search effect below cannot depend on
  // it without re-firing. A ref keeps the effect's dependency list honest.
  const searchRef = useRef<((override?: string) => Promise<void>) | undefined>(undefined)

  // The owner holds the draft, and it can arrive a render AFTER this panel mounts -- a Browse
  // card handing over "<title> <author>" goes through the URL first. Without this sync the local
  // box would still be empty when the auto-search fires, and `handleSearch` would bail on a
  // blank query. Only adopt a non-empty seed, so clearing the box is not immediately undone.
  useEffect(() => {
    if (initialQuery && initialQuery !== query) setQuery(initialQuery)
    // Keyed on the incoming seed alone: including `query` would fight the user's own typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuery])

  useEffect(() => {
    if (!searching) return
    setElapsedSeconds(0)
    const startedAt = Date.now()
    const timer = setInterval(() => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [searching])

  // Abort an in-flight search when the panel goes away, so its `setState` cannot land on an
  // unmounted component and the socket is not left open behind the user.
  useEffect(() => () => abortRef.current?.abort(), [])

  /**
   * @param override search this text instead of the box's current contents.
   *
   * The auto-search needs this. A Browse card's seed arrives through the owner a render after
   * this panel mounts, so at the moment the effect fires `query` has been *scheduled* but not
   * applied -- reading state here would search an empty string and silently do nothing.
   */
  const handleSearch = async (override?: string) => {
    const trimmed = (override ?? query).trim()
    if (!trimmed || searching) return
    // Drop focus so Android retracts the soft keyboard. Verified on device: it otherwise stays up
    // for the whole ~30s search and covers the Cancel search button, which made the way out of a
    // long search unreachable without first pressing Back.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    const controller = new AbortController()
    abortRef.current = controller
    setSearching(true)
    setError(null)
    // Cancel clears `abortRef`, and a newer search replaces it, so "this controller is still the
    // one in `abortRef`" is exactly "this is still the live request". Every state write below is
    // gated on it: otherwise search A, Cancel, search B, then A settling would run A's `finally`
    // and kill B's spinner -- or, if A resolved just before the abort landed, replace B's results
    // with A's. A superseded or cancelled request must unwind silently.
    const isActive = () => abortRef.current === controller
    try {
      const response = await api.searchAudiobooks(libraryId, trimmed, { signal: controller.signal })
      if (isActive()) setSearchResult(response)
    } catch (err) {
      // A cancel the user asked for is not an error worth shouting about: clear the spinner and
      // leave the previous results and the query alone so they can simply search again.
      if (controller.signal.aborted) return
      if (!isActive()) return
      console.error('Audiobook search failed', err)
      setError(formatAcquisitionError(err))
      setSearchResult(null)
    } finally {
      if (isActive()) {
        abortRef.current = null
        setSearching(false)
      }
    }
  }
  searchRef.current = handleSearch

  // A Browse card tap arrives as a seeded query plus `autoSearch`. Fire it once, then tell the
  // owner it has been consumed so coming back to this tab does not spend another ~30s fan-out.
  useEffect(() => {
    if (!autoSearch || !initialQuery.trim()) return
    void searchRef.current?.(initialQuery)
    onAutoSearchConsumed?.()
    // Intentionally keyed on the seed, not on the handler or on `onAutoSearchConsumed`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSearch, initialQuery])

  const handleCancelSearch = () => {
    abortRef.current?.abort()
    abortRef.current = null
    setSearching(false)
  }

  const handleConfirmAcquisition = async () => {
    if (!selected || !searchResult) return
    setSubmitting(true)
    try {
      const acquisition = await api.createAcquisition(libraryId, {
        searchSessionId: searchResult.searchSessionId,
        releaseId: selected.releaseId,
        idempotencyKey: crypto.randomUUID()
      })
      applyAcquisition(libraryId, acquisition)
      navigate(`/library/${libraryId}/acquisition-queue`)
    } catch (err) {
      console.error('Failed to create acquisition', err)
      setError(formatAcquisitionError(err))
    } finally {
      setSubmitting(false)
      setSelected(null)
    }
  }

  return (
    <div>
      {/* Always visible (not a toast): acquiring is server-side, offline listening needs a separate device download. */}
      <p className="text-foreground-muted mb-3 text-sm leading-snug" data-testid="discover-explainer">
        {t('MessageMobileDiscoverExplainer')}
      </p>

      <form
        className="mb-4 flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void handleSearch()
        }}
      >
        <TextInput
          type="search"
          size="small"
          label={t('LabelSearchAudiobooks')}
          placeholder={t('LabelSearchAudiobooks')}
          value={query}
          onChange={editQuery}
          enterKeyHint="search"
          trimWhitespace
          className="min-w-0 flex-1"
          clearable
          onClear={() => editQuery('')}
        />
        <Btn size="small" type="submit" color="bg-accent" disabled={!query.trim() || searching} loading={searching} className="shrink-0 justify-center">
          {t('ButtonSearch')}
        </Btn>
      </form>

      {error && (
        <p role="alert" className="text-error mb-3 text-sm">
          {error}
        </p>
      )}

      {searching && (
        <div data-testid="discover-searching">
          <LoadingView label={t('MessageMobileSearchingElapsed', { seconds: elapsedSeconds })} />
          <p className="text-foreground-subdued mt-1 text-center text-xs leading-snug">{t('MessageMobileSearchingSlowHint')}</p>
          <div className="mt-3 flex justify-center">
            <Btn size="small" color="bg-primary" onClick={handleCancelSearch}>
              {t('ButtonMobileCancelSearch')}
            </Btn>
          </div>
        </div>
      )}

      {!searching && searchResult && searchResult.results.length === 0 && (
        <PageMessage message={t('MessageMobileNoReleasesFound')} description={t('MessageMobileNoReleasesFoundDescription')} />
      )}

      {!searching && searchResult && searchResult.results.length > 0 && (
        <div className="flex flex-col gap-2" data-testid="discover-results">
          {searchResult.results.map((release) => (
            <ReleaseCard key={release.releaseId} release={release} onAcquire={setSelected} submitting={submitting && selected?.releaseId === release.releaseId} />
          ))}
        </div>
      )}

      <ConfirmDialog
        isOpen={!!selected}
        message={selected ? t('MessageConfirmAcquisition', { 0: selected.title }) : ''}
        description={t('MessageMobileConfirmAcquisitionSteps')}
        confirmLabel={t('ButtonAcquire')}
        processing={submitting}
        onClose={() => setSelected(null)}
        onConfirm={() => void handleConfirmAcquisition()}
      />
    </div>
  )
}
