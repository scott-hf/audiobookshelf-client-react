import type { DiscoverItem } from '@abs/acquisition-contract'
import { useTypeSafeTranslations } from '../hooks/useTypeSafeTranslations'
import type { OwnedMatch } from '../lib/discoverBrowse'
import BookCover from './BookCover'
import Badge from './Badge'

interface DiscoverBookCardProps {
  item: DiscoverItem
  /** How this book relates to the server library; see `findOwned`. */
  owned: OwnedMatch
  onOpenOwned: (id: string) => void
  onSearch: (item: DiscoverItem) => void
}

/**
 * A suggested book from the Open Library catalog, shaped like `BookCard`.
 *
 * Only a `confident` library match shows the "In server library" badge and opens the library book.
 * An `ambiguous` match (a title matched but identity is not established) shows NO badge and does
 * NOT navigate -- opening the wrong book on a fuzzy title match is worse than searching -- so it
 * behaves like `none` and hands the book to the acquisition search.
 *
 * `item.popularity` is deliberately never rendered: it counts Open Library readers, not listeners.
 */
export default function DiscoverBookCard({ item, owned, onOpenOwned, onSearch }: DiscoverBookCardProps) {
  const t = useTypeSafeTranslations()
  const confident = owned.kind === 'confident' ? owned.entry : null
  const label = t(confident ? 'LabelMobileBrowseCardOwned' : 'LabelMobileBrowseCardSearch', { title: item.title, author: item.author })

  return (
    <button
      type="button"
      aria-label={label}
      className="group focus-visible:outline-foreground-muted flex w-full flex-col text-left focus-visible:outline-1 focus-visible:outline-offset-2"
      onClick={() => (confident ? onOpenOwned(confident.id) : onSearch(item))}
    >
      {/* Same shape as BookCard: the wrapper is the overlay's offset parent, BookCover is untouched. */}
      <div className="relative w-full">
        <BookCover title={item.title} authorName={item.author} coverUrl={item.coverUrl} />
        {confident && (
          // Top-end, like BookCard's "finished" check, so one corner means "status" across covers
          // (this card has no progress bar, which owns the bottom edge in BookCard). It is out of
          // flow, so an owned card is no taller than an unowned one, and it is capped to the cover's
          // width. The label is decorative here: the card's aria-label already says "Open in your
          // library" vs "Find a copy to acquire", and aria-hidden stops it being read a second time.
          // pointer-events-none keeps the click on the card's single <button>.
          <div className="pointer-events-none absolute inset-x-1 top-1 flex justify-end" aria-hidden="true">
            <Badge tone="success-solid" className="max-w-full min-w-0">
              <span className="truncate">{t('LabelMobileAcquisitionAvailable')}</span>
            </Badge>
          </div>
        )}
      </div>
      <span className="text-foreground mt-1.5 line-clamp-2 text-sm leading-snug font-semibold">{item.title}</span>
      {item.author && <span className="text-foreground-subdued line-clamp-1 text-xs">{item.author}</span>}
    </button>
  )
}
