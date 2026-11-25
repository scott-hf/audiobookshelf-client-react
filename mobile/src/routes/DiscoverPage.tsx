import type { DiscoverItem } from '@abs/acquisition-contract'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import type { MobileAcquisitionClient } from '../api/acquisitionClient'
import { useAuth } from '../auth/AuthProvider'
import DiscoverBrowsePanel from '../components/DiscoverBrowsePanel'
import DiscoverSearchPanel from '../components/DiscoverSearchPanel'
import { useDiscoverOptions } from '../hooks/useDiscoverOptions'
import { useTypeSafeTranslations } from '../hooks/useTypeSafeTranslations'
import { mergeClasses } from '../lib/merge-classes'
import { parseDiscoverQuery, toDiscoverSearchParams, type BrowseSelection, type DiscoverMode } from '../lib/discoverBrowse'

/** Minimal shape this page and its panels need -- lets tests inject a fake implementation via
 * AuthContext without mocking the module import (mirrors the web app's DiscoverApi contract). */
export type DiscoverApi = Pick<MobileAcquisitionClient, 'searchAudiobooks' | 'createAcquisition' | 'getDiscoverOptions' | 'browseDiscover'>

/**
 * Discover: two ways to find a book your server does not have yet.
 *
 * **Search** is the original acquisition flow -- type a title, Librarr fans out to the indexers,
 * the server fetches the release you pick. It is the default tab, so visiting `/discover` does
 * exactly what it always did.
 *
 * **Browse** is a catalog of Open Library suggestions (Popular / New / Top rated, optionally
 * filtered by genre, plus a "For you" view built from your own listening). It restores the
 * Discover screen of the previous Kotlin app, which reached Librarr directly; here the same data
 * arrives through the acquisition gateway, so the Librarr API key stays server-side.
 *
 * Browse needs gateway routes that an older deployment will not have. When the options call comes
 * back as unsupported the whole tab disappears and Search carries on alone -- a server without
 * the proxy must not lose the feature it already had. Any *other* failure is reported with a
 * retry rather than silently hiding the tab, so a flat network does not look like a missing
 * feature.
 */
export default function DiscoverPage() {
  const t = useTypeSafeTranslations()
  const { libraryId } = useParams<{ libraryId: string }>()
  const navigate = useNavigate()
  const { acquisitionClient } = useAuth()
  const api: DiscoverApi | null = acquisitionClient
  const [searchParams, setSearchParams] = useSearchParams()

  const { options, status: optionsStatus, retry: retryOptions } = useDiscoverOptions()

  // The URL is the single source of truth for which tab is showing and what it is showing, so
  // Back out of a book returns to the same shelf and a deep link can point at one.
  const query = useMemo(() => parseDiscoverQuery(searchParams, options), [searchParams, options])

  // Set only by a Browse card tap, and cleared as soon as the search panel has consumed it, so
  // returning to the Search tab later does not re-run a ~30s indexer fan-out.
  const [autoSearch, setAutoSearch] = useState(false)

  // The live contents of the search box live HERE, not in the panel, because switching to Browse
  // unmounts the panel and would otherwise throw away whatever the user had typed. Deliberately
  // not kept in the URL: writing a history entry per keystroke to preserve a draft would be
  // worse than losing it.
  const [searchText, setSearchText] = useState('')

  // A Browse card hands its title and author over through the URL, so adopt that as the draft
  // when it changes.
  useEffect(() => {
    if (query.q) setSearchText(query.q)
  }, [query.q])

  const browseUnsupported = optionsStatus === 'hidden'
  // A server without the gateway routes has no Browse tab at all. If the URL asked for Browse
  // anyway -- an old link, or the options call failing after the tab was already open -- fall
  // back rather than rendering a tab that cannot work.
  const mode: DiscoverMode = browseUnsupported ? 'search' : query.mode

  const updateQuery = useCallback(
    (next: { mode?: DiscoverMode; selection?: BrowseSelection; q?: string }) => {
      // `replace` so flipping tabs and changing a dropdown do not each add a history entry the
      // user has to press Back through. Matches LibraryPage's filter/sort behaviour.
      setSearchParams(toDiscoverSearchParams({ ...query, ...next }), { replace: true })
    },
    [query, setSearchParams]
  )

  useEffect(() => {
    if (browseUnsupported && query.mode === 'browse') updateQuery({ mode: 'search' })
  }, [browseUnsupported, query.mode, updateQuery])

  if (!libraryId || !api) return null

  /** A Browse card the user does not own hands its title and author to Search and runs it. */
  const handleSearchForBook = (item: DiscoverItem) => {
    const seed = [item.title, item.author].filter(Boolean).join(' ').trim()
    setAutoSearch(true)
    updateQuery({ mode: 'search', q: seed })
  }

  const handleOpenOwned = (itemId: string) => {
    navigate(`/library/${libraryId}/item/${itemId}`)
  }

  const tabClasses = (selected: boolean) =>
    mergeClasses(
      'flex-1 rounded-md border px-3 py-1.5 text-sm font-semibold transition-colors',
      selected ? 'bg-accent border-accent text-black-600' : 'bg-primary border-border text-foreground hover:bg-bg-hover'
    )

  return (
    <div>
      <h1 className="text-foreground mb-1 text-lg font-semibold">{t('LabelDiscover')}</h1>

      {/* Hidden until the options call settles. Showing both tabs optimistically and then
          removing Browse -- which is what a server without the discover routes would do, i.e.
          this deployment today -- yanks a control out from under a thumb already reaching for
          it. Appearing a beat late on a server that does support it is the gentler failure. */}
      {!browseUnsupported && optionsStatus !== 'loading' && (
        <div role="tablist" aria-label={t('LabelMobileDiscoverModes')} className="mb-3 flex gap-2">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'browse'}
            onClick={() => updateQuery({ mode: 'browse' })}
            className={tabClasses(mode === 'browse')}
          >
            {t('LabelMobileDiscoverBrowse')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'search'}
            onClick={() => updateQuery({ mode: 'search' })}
            className={tabClasses(mode === 'search')}
          >
            {t('LabelMobileDiscoverSearch')}
          </button>
        </div>
      )}

      {mode === 'browse' ? (
        <DiscoverBrowsePanel
          libraryId={libraryId}
          options={options}
          optionsStatus={optionsStatus}
          onRetryOptions={retryOptions}
          selection={query.selection}
          onSelectionChange={(selection) => updateQuery({ selection })}
          onSearchForBook={handleSearchForBook}
          onOpenOwned={handleOpenOwned}
        />
      ) : (
        <DiscoverSearchPanel
          libraryId={libraryId}
          api={api}
          initialQuery={searchText}
          onQueryChange={setSearchText}
          autoSearch={autoSearch}
          onAutoSearchConsumed={() => setAutoSearch(false)}
        />
      )}
    </div>
  )
}
