import type { DiscoverItem, DiscoverOptionsResponse } from '@abs/acquisition-contract'
import type { ReactElement } from 'react'
import { useDiscoverBrowse } from '../hooks/useDiscoverBrowse'
import { useForYou } from '../hooks/useForYou'
import { useLibraryIndex } from '../hooks/useLibraryIndex'
import { useTypeSafeTranslations } from '../hooks/useTypeSafeTranslations'
import {
  browseCatalogs,
  findOwned,
  FOR_YOU_ID,
  GENRE_ALL_ID,
  nextSelectionOnGenre,
  POPULAR_CATALOG_ID,
  type BrowseSelection
} from '../lib/discoverBrowse'
import type { TranslationKey } from '../types/translations'
import DiscoverBookCard from './DiscoverBookCard'
import LoadingView from './LoadingView'
import SelectField from './SelectField'
import Btn from './ui/Btn'
import PageMessage from './ui/PageMessage'
import SkeletonBar from './ui/SkeletonBar'

interface DiscoverBrowsePanelProps {
  libraryId: string
  options: DiscoverOptionsResponse | null
  optionsStatus: 'loading' | 'ready' | 'hidden' | 'error'
  onRetryOptions: () => void
  selection: BrowseSelection
  onSelectionChange: (selection: BrowseSelection) => void
  onSearchForBook: (item: DiscoverItem) => void
  onOpenOwned: (itemId: string) => void
}

/** A card renderer closed over the owned index, so both bodies mark owned books identically. */
type RenderCard = (item: DiscoverItem) => ReactElement

/** Same grid as `LibraryPage`, so a shelf of suggestions reads as the same kind of thing as a
 * shelf of books you own. */
const GRID = 'grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4'

/** Enough placeholders to fill the first screen without implying a page size we do not know yet. */
const SKELETON_COUNT = 9

function CardSkeletons() {
  return (
    <div className={GRID} role="status" aria-busy="true">
      {Array.from({ length: SKELETON_COUNT }, (_, i) => (
        <div key={i} className="flex flex-col gap-2">
          <div className="bg-primary aspect-square w-full rounded-md" />
          <SkeletonBar className="w-full" />
          <SkeletonBar className="w-2/3" />
        </div>
      ))}
    </div>
  )
}

/**
 * The copy for a gateway failure code, or `null` when the code tells us nothing specific.
 *
 * Only two codes actually name Open Library: `discover_rate_limited` and
 * `discover_upstream_unavailable`. Everything else -- a dropped connection (no code), a gateway
 * timeout (`librarr_timeout`), an unreachable Librarr (`librarr_unreachable`), a malformed
 * response (`discover_bad_response`) -- may have nothing to do with Open Library, so blaming it
 * (or promising that Search still works, when the gateway or network is what failed) would be
 * guessing. Callers supply their own generic fallback for `null`.
 */
function failureMessageKey(code: string | null): TranslationKey | null {
  if (code === 'discover_rate_limited') return 'MessageMobileBrowseRateLimited'
  if (code === 'discover_upstream_unavailable') return 'MessageMobileBrowseUnavailable'
  return null
}

/** Retryable failure notice. Rate limiting gets its own wording because "try again" is only
 * honest advice if the user is told to wait. */
function FailureNotice({ errorCode, onRetry }: { errorCode: string | null; onRetry: () => void }) {
  const t = useTypeSafeTranslations()
  const message = t(failureMessageKey(errorCode) ?? 'MessageMobileBrowseFailed')
  return (
    <div>
      <p role="alert" className="text-error mb-3 text-sm">
        {message}
      </p>
      <Btn size="small" color="bg-primary" onClick={onRetry}>
        {t('ButtonRetry')}
      </Btn>
    </div>
  )
}

/**
 * Browse: Open Library suggestions, filtered by catalog and genre, plus a "For you" view built
 * from the user's own listening.
 *
 * Three things here are deliberate and should survive refactoring.
 *
 * **An outage never looks like an empty shelf.** Open Library stalls for tens of seconds and
 * sometimes fails outright (measured: 3.6-37s, with hard timeouts), so a failed fetch, a genre
 * with genuinely no books, and a selection the server no longer offers each get their own
 * message. Collapsing them would tell the user "no books here" when the truth is "we could not
 * ask".
 *
 * **Paging follows the server's cursor only.** A short page is not the last page -- a real
 * `science fiction` page returned 7 of 20 items with the cursor still advancing, because Open
 * Library drops works that fail the catalog's filter. `hasMore` comes from the cursor, never
 * from `items.length`.
 *
 * **Each body owns its own fetching hook.** `CatalogBody` and `ForYouBody` are separate
 * components precisely so their hooks mount only when that tab is on screen. Hoisting
 * `useForYou` into this component would fire up to three upstream calls per genre every time
 * someone merely looked at Popular, against a discover bucket of 60 requests/minute shared by
 * every user of that Librarr.
 */
export default function DiscoverBrowsePanel({
  libraryId,
  options,
  optionsStatus,
  onRetryOptions,
  selection,
  onSelectionChange,
  onSearchForBook,
  onOpenOwned
}: DiscoverBrowsePanelProps) {
  const t = useTypeSafeTranslations()
  // Needed by both bodies, and cheap: the index is cached per server and library, and this
  // library is 103 items / 163 KB. A failure here is non-fatal -- the hook hands back an empty
  // index rather than null, so cards simply go unbadged instead of the tab breaking.
  const { index: ownedIndex } = useLibraryIndex(libraryId)

  if (optionsStatus === 'loading') return <LoadingView label={t('MessageMobileBrowseLoading')} />

  // `hidden` is handled by the page, which drops this tab entirely; anything else is a fault
  // worth retrying rather than a reason to hide the feature.
  if (optionsStatus === 'error' || !options) return <FailureNotice errorCode={null} onRetry={onRetryOptions} />

  const catalogs = browseCatalogs(options)
  const selectedCatalogId = selection.kind === 'forYou' ? FOR_YOU_ID : selection.catalogId
  // For you carries no genre of its own: picking one is what moves the user off it (see
  // `nextSelectionOnGenre`), so the picker shows "all genres" while For you is selected.
  const selectedGenreId = selection.kind === 'forYou' ? GENRE_ALL_ID : (selection.genreId ?? GENRE_ALL_ID)

  // A controlled <select> whose value matches no <option> silently DISPLAYS its first option
  // while the state -- and so the request -- says something else: the user would read "Popular"
  // and be served Fantasy. Both values can legitimately fall outside the lists: a genre arrives
  // from a deep link or restored URL state (a cleaned library genre is a valid `genre` that
  // Librarr's option list need not contain), and the catalog pinned by state (`popular` is
  // accepted without options) may not be among the server's. Rather than coerce the value, which
  // would change what is requested behind the user's back, render the selection as an option so
  // the picker shows exactly what is being asked for. The sentinels always have an option.
  const catalogUnlisted = selectedCatalogId !== FOR_YOU_ID && !catalogs.some((catalog) => catalog.id === selectedCatalogId)
  const catalogFallbackLabel = selectedCatalogId === POPULAR_CATALOG_ID ? t('LabelMobileCatalogPopular') : selectedCatalogId
  const genreUnlisted = selectedGenreId !== GENRE_ALL_ID && !options.genres.some((genre) => genre.id === selectedGenreId)
  const genreFallbackLabel = (selection.kind === 'catalog' ? selection.genreLabel : null) || selectedGenreId

  const handleCatalogChange = (id: string) => {
    if (id === FOR_YOU_ID) {
      onSelectionChange({ kind: 'forYou' })
      return
    }
    // Keep the genre when switching catalog: having picked Fantasy, the user means to stay in
    // Fantasy while comparing Popular against Top rated.
    const genreId = selection.kind === 'catalog' ? selection.genreId : null
    const genreLabel = selection.kind === 'catalog' ? selection.genreLabel : null
    onSelectionChange({ kind: 'catalog', catalogId: id, genreId, genreLabel })
  }

  const handleGenreChange = (id: string) => {
    const genreId = id === GENRE_ALL_ID ? null : id
    const genreLabel = genreId ? (options.genres.find((g) => g.id === genreId)?.label ?? null) : null
    onSelectionChange(nextSelectionOnGenre(selection, genreId, genreLabel, options))
  }

  const renderCard: RenderCard = (item) => (
    <DiscoverBookCard
      key={item.key}
      item={item}
      owned={findOwned(ownedIndex, item.title, item.author)}
      onOpenOwned={onOpenOwned}
      onSearch={onSearchForBook}
    />
  )

  return (
    <div>
      <div className="mb-2 grid grid-cols-2 gap-3">
        <SelectField
          id="discover-catalog"
          layout="stacked"
          label={t('LabelMobileBrowseCatalog')}
          value={selectedCatalogId}
          onChange={(e) => handleCatalogChange(e.target.value)}
        >
          {catalogs.map((catalog) => (
            <option key={catalog.id} value={catalog.id}>
              {catalog.label}
            </option>
          ))}
          {catalogUnlisted && <option value={selectedCatalogId}>{catalogFallbackLabel}</option>}
          <option value={FOR_YOU_ID}>{t('LabelMobileBrowseForYou')}</option>
        </SelectField>

        <SelectField id="discover-genre" layout="stacked" label={t('LabelGenre')} value={selectedGenreId} onChange={(e) => handleGenreChange(e.target.value)}>
          <option value={GENRE_ALL_ID}>{t('LabelMobileBrowseAllGenres')}</option>
          {options.genres.map((genre) => (
            <option key={genre.id} value={genre.id}>
              {genre.label}
            </option>
          ))}
          {genreUnlisted && <option value={selectedGenreId}>{genreFallbackLabel}</option>}
        </SelectField>
      </div>

      {/* Named, not buried in a tooltip: "Popular" here ranks by Open Library reading-log adds
          (which include "Want to Read"), which is not the same as audiobook listeners and is not
          this server's users. */}
      <p className="text-foreground-subdued mb-3 text-xs leading-snug">{t('MessageMobileBrowseSourceNote')}</p>

      {selection.kind === 'forYou' ? (
        <ForYouBody libraryId={libraryId} renderCard={renderCard} onBrowsePopular={() => handleCatalogChange(POPULAR_CATALOG_ID)} />
      ) : (
        <CatalogBody selection={selection} renderCard={renderCard} />
      )}
    </div>
  )
}

function CatalogBody({ selection, renderCard }: { selection: BrowseSelection; renderCard: RenderCard }) {
  const t = useTypeSafeTranslations()
  const browse = useDiscoverBrowse(selection)

  if (browse.status === 'loading') return <CardSkeletons />
  if (browse.status === 'error') return <FailureNotice errorCode={browse.errorCode} onRetry={browse.retry} />

  // A selection the server has stopped offering is not the same as a shelf with nothing on it:
  // the fix is to pick something else, so say that instead of "no books here".
  if (browse.status === 'invalid') return <PageMessage message={t('MessageMobileBrowseInvalid')} />

  // Only the hook's own `empty` ends the shelf. Adding `|| items.length === 0` here would strand
  // the user on a page Open Library happened to filter down to nothing while the cursor was
  // still advancing -- the empty message would render with no Load more under it. The hook
  // reports that case as `ready` with `hasMore`, and it is a real one: a live `science fiction`
  // page came back with 7 of 20 items.
  if (browse.status === 'empty') return <PageMessage message={t('MessageMobileBrowseEmpty')} />

  return (
    <div>
      {/* Librarr sets `partial` when a ranked catalog fell back to relevance order. Presenting
          that as "Popular" or "Top rated" would be a quiet lie about what the order means. */}
      {browse.partial && <p className="text-foreground-subdued mb-2 text-xs">{t('MessageMobileBrowsePartial')}</p>}

      {browse.items.length > 0 ? (
        <div className={GRID}>{browse.items.map(renderCard)}</div>
      ) : (
        // Nothing survived this page's filters, but the cursor says there is more: say so rather
        // than showing a bare Load more under a blank space.
        <p className="text-foreground-muted text-sm">{t('MessageMobileBrowseEmpty')}</p>
      )}

      {(browse.hasMore || browse.loadMoreFailed) && (
        <div className="mt-4 flex flex-col items-center gap-2">
          {browse.hasMore && (
            <Btn size="small" color="bg-primary" loading={browse.loadingMore} onClick={browse.loadMore}>
              {t('ButtonMobileLoadMore')}
            </Btn>
          )}
          {/* A failed later page keeps the cards already on screen; retrying resumes at the
              cursor that failed rather than starting the shelf over. The notice is NOT tied to
              `hasMore`: a later page the server no longer accepts (`discover_invalid_selection`)
              clears the cursor, and the Load more button vanishing with no explanation would be
              the worst way to say so. In that case retrying cannot help, so say the selection is
              gone instead of offering a retry. */}
          {browse.loadMoreFailed && (
            <p role="alert" className="text-error text-xs">
              {browse.errorCode === 'discover_invalid_selection' ? t('MessageMobileBrowseInvalid') : t(failureMessageKey(browse.errorCode) ?? 'MessageMobileLoadMoreFailed')}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function ForYouBody({ libraryId, renderCard, onBrowsePopular }: { libraryId: string; renderCard: RenderCard; onBrowsePopular: () => void }) {
  const t = useTypeSafeTranslations()
  const forYou = useForYou(libraryId)

  if (forYou.status === 'loading') return <CardSkeletons />

  if (forYou.status === 'error') {
    return (
      <p role="alert" className="text-error text-sm">
        {t('MessageMobileBrowseFailed')}
      </p>
    )
  }

  // No listening history is a normal state for a new account, not a failure -- and it must not
  // borrow the failure message. Offer the way forward instead.
  if (forYou.status === 'empty' || forYou.rows.length === 0) {
    return (
      <div>
        {/* Different situations, different sentences. Telling someone to go and listen to a few
            books when they already have is just wrong -- and on this library `no-results` is the
            likely branch, since half the books carry no genre but "Audiobook". The hook says which
            one it is; `null` should not co-occur with an empty shelf, and if it ever does the
            safe sentence is the one that does not accuse the listener of having no history. */}
        <PageMessage message={forYou.reason === 'no-history' ? t('MessageMobileForYouEmpty') : t('MessageMobileForYouNoMatches')} />
        <div className="mt-3 flex justify-center">
          <Btn size="small" color="bg-primary" onClick={onBrowsePopular}>
            {t('ButtonMobileBrowsePopular')}
          </Btn>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Some rows loaded and some did not. Saying so beats silently showing a shorter list as
          though it were the whole answer. */}
      {forYou.incomplete && <p className="text-foreground-subdued text-xs">{t('MessageMobileForYouIncomplete')}</p>}

      {forYou.rows.map((row) => (
        <section key={row.genre}>
          {/* `partial` means a ranked catalog fell back to relevance order, so this row is not a
              popularity ranking and must not be headed as one. */}
          <h2 className="text-foreground mb-2 text-sm font-semibold">{t(row.partial ? 'LabelMobileForYouRelatedIn' : 'LabelMobileForYouPopularIn', { genre: row.genre })}</h2>
          <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-1">
            {row.items.map((item) => (
              <div key={item.key} className="w-24 shrink-0">
                {renderCard(item)}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
