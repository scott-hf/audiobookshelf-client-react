import { useState } from 'react'
import { mergeClasses } from '@/lib/merge-classes'

interface BookCoverProps {
  title: string
  authorName?: string | null
  coverUrl?: string | null
  className?: string
}

/**
 * Book cover with a typographic fallback.
 *
 * ABS serves covers from /api/items/{id}/cover, but items without artwork return a
 * placeholder and offline items may have no reachable URL at all -- so a failed or absent
 * image degrades to a title/author card rather than a broken-image box.
 */
export default function BookCover({ title, authorName, coverUrl, className }: BookCoverProps) {
  const [failed, setFailed] = useState(false)
  const showImage = !!coverUrl && !failed

  return (
    <div className={mergeClasses('bg-black-500 box-shadow-book relative aspect-2/3 w-full overflow-hidden rounded-md', className)}>
      {showImage ? (
        <img src={coverUrl} alt="" loading="lazy" className="h-full w-full object-cover" onError={() => setFailed(true)} />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1 p-2 text-center">
          <span className="material-symbols text-foreground-subdued/50 text-3xl" aria-hidden="true">
            book_2
          </span>
          <span className="text-foreground-muted line-clamp-3 text-xs font-semibold">{title}</span>
          {authorName ? <span className="text-foreground-subdued line-clamp-1 text-xxs">{authorName}</span> : null}
        </div>
      )}
    </div>
  )
}
