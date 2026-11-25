import { useEffect, useMemo, type ReactElement } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { hasEntities, isAuthorsShelf, isBookShelf, isSeriesShelf, orderShelvesHistoryFirst } from '../api/shelfUtils'
import { useAuth } from '../auth/AuthProvider'
import AuthorCard from '../components/AuthorCard'
import BookCard from '../components/BookCard'
import SeriesCard from '../components/SeriesCard'
import ShelfRail, { ShelfRailItem } from '../components/ShelfRail'
import Btn from '../components/ui/Btn'
import IconBtn from '../components/ui/IconBtn'
import PageMessage from '../components/ui/PageMessage'
import SkeletonBar from '../components/ui/SkeletonBar'
import { useLibraryShelves } from '../hooks/useLibraryShelves'
import { useTypeSafeTranslations } from '../hooks/useTypeSafeTranslations'
import { useUserProgress } from '../progress/UserProgressProvider'

const ACTION_LINK_CLASS =
  'bg-primary border-border text-foreground hover:bg-bg-hover flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors'

/** Placeholder rails shown during the first load so the page keeps its shape once shelves land. */
function ShelvesSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label}>
      {[0, 1].map((rail) => (
        <div key={rail} className="mb-6" aria-hidden="true">
          <SkeletonBar className="mb-2 h-5 w-40" />
          <div className="-mx-4 flex gap-3 overflow-hidden px-4">
            {[0, 1, 2, 3].map((card) => (
              <div key={card} className="w-28 shrink-0">
                <SkeletonBar className="aspect-2/3 w-full" animationDelay={`${card * 100}ms`} />
                <SkeletonBar className="mt-2 h-3 w-24" />
                <SkeletonBar className="mt-1 h-3 w-16" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * The library landing page: the server's personalized shelves as horizontal rails, with the
 * listening-history shelves (continue listening / continue series / listen again) first.
 *
 * Shelves are rendered by `type`, never by `id`: the server's set and ids vary with library
 * contents and version, so an unknown type or an empty shelf is skipped rather than special-cased.
 * The flat, paginated catalogue lives at `<library>/books` (`LibraryPage`).
 */
export default function LibraryHomePage() {
  const t = useTypeSafeTranslations()
  const { libraryId } = useParams<{ libraryId: string }>()
  const { client } = useAuth()
  const navigate = useNavigate()
  const { getProgress, refresh: refreshProgress } = useUserProgress()
  const { shelves, status, refreshing, refresh } = useLibraryShelves(libraryId)

  // Progress made in the player since the provider's first fetch isn't in its map yet; pick it up
  // whenever the home is (re)opened. Concurrent refreshes share one request, so a cold start
  // does not double-fetch.
  useEffect(() => {
    void refreshProgress()
  }, [refreshProgress])

  const libraryPath = libraryId ? `/library/${encodeURIComponent(libraryId)}` : ''

  const rails = useMemo(() => {
    const result: ReactElement[] = []
    for (const shelf of orderShelvesHistoryFirst(shelves ?? [])) {
      if (!hasEntities(shelf)) continue
      if (isBookShelf(shelf)) {
        result.push(
          <ShelfRail key={shelf.id} label={shelf.label}>
            {shelf.entities.map((item) => (
              <ShelfRailItem key={item.id}>
                <BookCard
                  item={item}
                  progress={getProgress(item.id)}
                  coverUrl={client.authorizedStreamUrl(`/api/items/${encodeURIComponent(item.id)}/cover`)}
                  onSelect={(selected) => navigate(`${libraryPath}/item/${encodeURIComponent(selected.id)}`)}
                />
              </ShelfRailItem>
            ))}
          </ShelfRail>
        )
      } else if (isSeriesShelf(shelf)) {
        result.push(
          <ShelfRail key={shelf.id} label={shelf.label}>
            {shelf.entities.map((series) => {
              const firstBook = series.books?.[0]
              return (
                <ShelfRailItem key={series.id}>
                  <SeriesCard series={series} coverUrl={firstBook ? client.authorizedStreamUrl(`/api/items/${encodeURIComponent(firstBook.id)}/cover`) : null} />
                </ShelfRailItem>
              )
            })}
          </ShelfRail>
        )
      } else if (isAuthorsShelf(shelf)) {
        result.push(
          <ShelfRail key={shelf.id} label={shelf.label}>
            {shelf.entities.map((author) => (
              <ShelfRailItem key={author.id}>
                <AuthorCard author={author} imageUrl={author.imagePath ? client.authorizedStreamUrl(`/api/authors/${encodeURIComponent(author.id)}/image`) : null} />
              </ShelfRailItem>
            ))}
          </ShelfRail>
        )
      }
      // Any other type (podcast, episode, or one this client has never seen) is skipped.
    }
    return result
  }, [shelves, getProgress, client, navigate, libraryPath])

  if (!libraryId) return null

  const showSkeleton = shelves === null && (status === 'loading' || refreshing)
  // A failed refresh keeps the old shelves visible below the alert; only a first-load failure
  // leaves the page without rails.
  const showError = status === 'error' && !refreshing

  const handleRefresh = () => {
    refresh()
    void refreshProgress()
  }

  return (
    <div>
      {/* Always rendered, so a failed or empty shelf fetch never strands the user away from the
          full list, Discover or the queue. */}
      <nav className="mb-4 flex items-center gap-2" aria-label="Library actions">
        <Link to={`${libraryPath}/books`} className={ACTION_LINK_CLASS}>
          <span className="material-symbols text-base" aria-hidden="true">
            library_books
          </span>
          {t('ButtonMobileAllBooks')}
        </Link>
        <Link to={`${libraryPath}/discover`} className={ACTION_LINK_CLASS}>
          <span className="material-symbols text-base" aria-hidden="true">
            travel_explore
          </span>
          {t('ButtonMobileDiscover')}
        </Link>
        <Link to={`${libraryPath}/acquisition-queue`} className={ACTION_LINK_CLASS}>
          <span className="material-symbols text-base" aria-hidden="true">
            playlist_add_check
          </span>
          {t('ButtonMobileAcquisitionQueue')}
        </Link>
        <IconBtn ariaLabel={t('ButtonRefresh')} loading={refreshing} onClick={handleRefresh} className="ms-auto">
          refresh
        </IconBtn>
      </nav>

      {showError && (
        <div role="alert" className="mb-4 flex flex-col items-center gap-2 py-4 text-center">
          <p className="text-error">{t('MessageMobileShelvesLoadFailed')}</p>
          <Btn size="small" onClick={refresh}>
            {t('ButtonRetry')}
          </Btn>
        </div>
      )}
      {showSkeleton && <ShelvesSkeleton label={t('MessageMobileLoadingShelves')} />}
      {shelves !== null && rails}
      {shelves !== null && rails.length === 0 && (
        <PageMessage message={t('MessageMobileNoShelves')} description={t('MessageMobileNoShelvesDescription')}>
          <Btn size="small" to={`${libraryPath}/books`}>
            {t('ButtonMobileAllBooks')}
          </Btn>
        </PageMessage>
      )}
    </div>
  )
}
