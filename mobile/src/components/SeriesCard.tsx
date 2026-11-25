import BookCover from './BookCover'
import { useTypeSafeTranslations } from '../hooks/useTypeSafeTranslations'
import type { AbsSeries } from '../types/abs'

interface SeriesCardProps {
  series: AbsSeries
  /** Cover of the series' first book, resolved by the caller (it owns the authorized URL). */
  coverUrl?: string | null
}

/**
 * Lightweight series tile: the first book's cover over the series name and book count.
 *
 * Deliberately not interactive yet -- the app has no series-detail route, and a tappable card
 * that goes nowhere is worse than a plain one. Wrap it in a button once that route exists.
 */
export default function SeriesCard({ series, coverUrl }: SeriesCardProps) {
  const t = useTypeSafeTranslations()
  const bookCount = series.books?.length ?? 0
  return (
    <div className="flex w-full flex-col text-left">
      <BookCover title={series.name} coverUrl={coverUrl} />
      <span className="text-foreground mt-1.5 line-clamp-2 text-sm leading-snug font-semibold">{series.name}</span>
      {bookCount > 0 && <span className="text-foreground-subdued line-clamp-1 text-xs">{t('LabelMobileSeriesBookCount', { count: bookCount })}</span>}
    </div>
  )
}
