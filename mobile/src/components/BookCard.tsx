import BookCover from './BookCover'
import type { AbsLibraryItem, AbsMediaProgress } from '../types/abs'

interface BookCardProps {
  item: AbsLibraryItem
  onSelect: (item: AbsLibraryItem) => void
  coverUrl?: string | null
  /** The user's progress for this item, resolved by the caller from `useUserProgress().getProgress`.
   * List/personalized endpoints never populate `item.userMediaProgress`, so this is what actually
   * drives the bar; the item field is only a fallback for expanded items that do carry it. */
  progress?: AbsMediaProgress | null
}

export default function BookCard({ item, onSelect, coverUrl, progress: progressProp }: BookCardProps) {
  const { title, authorName } = item.media.metadata
  const mediaProgress = progressProp ?? item.userMediaProgress
  const progress = mediaProgress?.progress ?? 0
  const progressPercent = Math.round(progress * 100)
  const isFinished = mediaProgress?.isFinished ?? false

  return (
    <button
      type="button"
      className="group focus-visible:outline-foreground-muted flex w-full flex-col text-left focus-visible:outline-1 focus-visible:outline-offset-2"
      onClick={() => onSelect(item)}
    >
      <div className="relative w-full">
        <BookCover title={title} authorName={authorName} coverUrl={coverUrl} />
        {isFinished && (
          <span
            className="bg-success text-button-foreground absolute end-1 top-1 flex size-5 items-center justify-center rounded-full"
            aria-label="Finished"
          >
            <span className="material-symbols text-sm" aria-hidden="true">
              check
            </span>
          </span>
        )}
        {progress > 0 && !isFinished && (
          <div
            className="bg-track-bg box-shadow-progressbar absolute inset-x-0 bottom-0 h-1 overflow-hidden rounded-b-md"
            role="progressbar"
            aria-valuenow={progressPercent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="bg-accent h-full" style={{ width: `${progressPercent}%` }} />
          </div>
        )}
      </div>
      <span className="text-foreground mt-1.5 line-clamp-2 text-sm leading-snug font-semibold">{title}</span>
      {authorName && <span className="text-foreground-subdued line-clamp-1 text-xs">{authorName}</span>}
    </button>
  )
}
