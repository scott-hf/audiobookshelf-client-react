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
      <BookCover title={item.title} authorName={item.author} coverUrl={item.coverUrl} />
      <span className="text-foreground mt-1.5 line-clamp-2 text-sm leading-snug font-semibold">{item.title}</span>
      {item.author && <span className="text-foreground-subdued line-clamp-1 text-xs">{item.author}</span>}
      {confident && (
        <Badge tone="success" className="mt-1 self-start">
          {t('LabelMobileAcquisitionAvailable')}
        </Badge>
      )}
    </button>
  )
}
