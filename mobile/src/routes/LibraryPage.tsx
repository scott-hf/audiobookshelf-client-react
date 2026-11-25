import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import BookCard from '../components/BookCard'
import LibraryFilterSheet from '../components/LibraryFilterSheet'
import LoadingView from '../components/LoadingView'
import Btn from '../components/ui/Btn'
import PageMessage from '../components/ui/PageMessage'
import { useDownloads } from '../downloads/DownloadProvider'
import { useLibraryFilterData } from '../hooks/useLibraryFilterData'
import { useLibraryItems } from '../hooks/useLibraryItems'
import { useTypeSafeTranslations } from '../hooks/useTypeSafeTranslations'
import { parseFilter } from '../lib/filterUtils'
import { DEFAULT_LIBRARY_QUERY, describeActiveFilter, parseLibraryQuery, toSearchParams, type LibraryQuery } from '../lib/libraryQuery'
import { useUserProgress } from '../progress/UserProgressProvider'

const chipClass = 'bg-primary border-border text-foreground flex min-h-9 items-center gap-1 rounded-full border ps-3 pe-1.5 text-sm'

export default function LibraryPage() {
  const t = useTypeSafeTranslations()
  const { libraryId } = useParams<{ libraryId: string }>()
  const { client } = useAuth()
  const navigate = useNavigate()
  const { isLocal } = useDownloads()
  const { getProgress, refresh: refreshProgress } = useUserProgress()
  const [searchParams, setSearchParams] = useSearchParams()
  const [sheetOpen, setSheetOpen] = useState(false)

  // Filter/sort live in the URL, not state, so a filtered list is still there after opening a book
  // and pressing back. Memoised on the string form because `searchParams` is a fresh object per render.
  const searchKey = searchParams.toString()
  const query = useMemo(() => parseLibraryQuery(new URLSearchParams(searchKey)), [searchKey])
  // `replace`: tweaking filters shouldn't stack history entries -- back should leave the list.
  const updateQuery = (next: LibraryQuery) => setSearchParams(toSearchParams(next), { replace: true })

  // `collapseseries` is not requested here: the server silently drops it whenever `filter` is set,
  // so a collapse toggle would work only some of the time.
  const { items, total, status, hasMore, loadingMore, loadMoreFailed, loadMore } = useLibraryItems(libraryId, {
    sort: query.sort,
    desc: query.desc,
    filter: query.filter ?? undefined
  })

  // An author/series chip needs a name; the book page passes one in the URL, but a hand-typed or
  // older link may not have it, so fall back to /filterdata in that case.
  const activeFilter = parseFilter(query.filter)
  const needsEntityName = (activeFilter?.group === 'authors' || activeFilter?.group === 'series') && !query.label
  const { filterData, status: filterDataStatus, retry: retryFilterData } = useLibraryFilterData(libraryId, sheetOpen || needsEntityName)
  const filterChipText = describeActiveFilter(query, filterData, t)

  // Progress made in the player since the provider's first fetch isn't in its map yet; pick it up
  // whenever the library is (re)opened. Concurrent refreshes share one request, so on a cold
  // start this does not double-fetch.
  useEffect(() => {
    void refreshProgress()
  }, [refreshProgress])

  // "Downloaded" is client-side: the server has no notion of what is on this phone. Narrowing only
  // the loaded pages would hide matches that sit on pages not fetched yet, so while it is on we
  // keep pulling pages until the server-filtered, server-sorted list is complete and THEN narrow it.
  // A failed page stops the loop (the retry button takes over) instead of hammering the server.
  const scanning = query.downloaded && status === 'ready' && hasMore
  useEffect(() => {
    if (scanning && !loadingMore && !loadMoreFailed) loadMore()
  }, [scanning, loadingMore, loadMoreFailed, loadMore])

  if (!libraryId) return null

  const libraryPath = `/library/${encodeURIComponent(libraryId)}`
  const visibleItems = query.downloaded ? items.filter((item) => isLocal(item.id)) : items
  const hasNonDefaultSort = query.sort !== DEFAULT_LIBRARY_QUERY.sort || query.desc
  const filtersApplied = query.filter !== null || query.downloaded

  return (
    <div>
      <nav className="mb-4 flex gap-2" aria-label={t('LabelMobileLibraryActions')}>
        <Link
          to={`${libraryPath}/discover`}
          className="bg-primary border-border text-foreground hover:bg-bg-hover flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors"
        >
          <span className="material-symbols text-base" aria-hidden="true">
            travel_explore
          </span>
          {t('ButtonMobileDiscover')}
        </Link>
        <Link
          to={`${libraryPath}/acquisition-queue`}
          className="bg-primary border-border text-foreground hover:bg-bg-hover flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors"
        >
          <span className="material-symbols text-base" aria-hidden="true">
            playlist_add_check
          </span>
          {t('ButtonMobileAcquisitionQueue')}
        </Link>
        <button
          type="button"
          className="bg-primary border-border text-foreground hover:bg-bg-hover ms-auto flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors"
          aria-haspopup="dialog"
          onClick={() => setSheetOpen(true)}
        >
          <span className="material-symbols text-base" aria-hidden="true">
            tune
          </span>
          {t('LabelMobileFilterAndSort')}
          {(filtersApplied || hasNonDefaultSort) && <span className="bg-accent size-1.5 rounded-full" aria-hidden="true" />}
        </button>
      </nav>

      {filtersApplied && (
        <div className="mb-4 flex flex-wrap gap-2">
          {filterChipText && (
            <span className={chipClass}>
              {filterChipText}
              <button
                type="button"
                className="material-symbols hover:text-error flex size-6 items-center justify-center rounded-full text-base"
                aria-label={t('LabelMobileClearFilterNamed', { filter: filterChipText })}
                onClick={() => updateQuery({ ...query, filter: null, label: null })}
              >
                close
              </button>
            </span>
          )}
          {query.downloaded && (
            <span className={chipClass}>
              {t('LabelMobileDownloadComplete')}
              <button
                type="button"
                className="material-symbols hover:text-error flex size-6 items-center justify-center rounded-full text-base"
                aria-label={t('LabelMobileClearFilterNamed', { filter: t('LabelMobileDownloadComplete') })}
                onClick={() => updateQuery({ ...query, downloaded: false })}
              >
                close
              </button>
            </span>
          )}
        </div>
      )}

      <LibraryFilterSheet
        isOpen={sheetOpen}
        onClose={() => setSheetOpen(false)}
        query={query}
        onChange={updateQuery}
        filterData={filterData}
        filterDataStatus={filterDataStatus}
        onRetryFilterData={retryFilterData}
      />

      {status === 'error' && (
        <p role="alert" className="text-error py-10 text-center">
          {t('MessageMobileLibraryLoadFailed')}
        </p>
      )}
      {status === 'loading' && <LoadingView label={t('MessageMobileLoadingBooks')} />}
      {status === 'ready' && items.length === 0 && <PageMessage message={t(filtersApplied ? 'MessageMobileNoBooksMatchFilter' : 'MessageMobileNoBooksInLibrary')} />}
      {status === 'ready' && items.length > 0 && (
        <>
          {visibleItems.length === 0 && !scanning && <PageMessage message={t('MessageMobileNoDownloadedMatches')} />}
          <div className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4">
            {visibleItems.map((item) => (
              <BookCard
                key={item.id}
                item={item}
                progress={getProgress(item.id)}
                coverUrl={client.authorizedStreamUrl(`/api/items/${encodeURIComponent(item.id)}/cover`)}
                onSelect={(selected) => navigate(`${libraryPath}/item/${encodeURIComponent(selected.id)}`)}
              />
            ))}
          </div>
          <div className="mt-6 flex flex-col items-center gap-2">
            {total !== null && (
              <p className="text-foreground-subdued text-xs" role={scanning ? 'status' : undefined}>
                {!query.downloaded
                  ? t('LabelMobileBooksLoadedCount', { loaded: items.length, total })
                  : scanning
                    ? t('MessageMobileCheckingDownloads', { loaded: items.length, total })
                    : t('LabelMobileDownloadedCount', { count: visibleItems.length, total })}
              </p>
            )}
            {loadMoreFailed && (
              <p role="alert" className="text-error text-sm">
                {t('MessageMobileLoadMoreFailed')}
              </p>
            )}
            {/* In Downloaded mode pages load themselves, so the button only appears to retry a failure. */}
            {hasMore && (!query.downloaded || loadMoreFailed) && (
              <Btn size="small" loading={loadingMore} onClick={loadMore}>
                {t('ButtonMobileLoadMore')}
              </Btn>
            )}
          </div>
        </>
      )}
    </div>
  )
}
