import { useState } from 'react'
import { useTypeSafeTranslations } from '../hooks/useTypeSafeTranslations'
import type { AbsAuthor } from '../types/abs'

interface AuthorCardProps {
  author: AbsAuthor
  /** Portrait URL, or null/undefined when the author has none (`imagePath` is often empty). */
  imageUrl?: string | null
}

/**
 * Lightweight author tile: a round portrait (person icon when there is none, or it fails to
 * load) over the name and book count. Not interactive yet -- the app has no author-detail route.
 */
export default function AuthorCard({ author, imageUrl }: AuthorCardProps) {
  const t = useTypeSafeTranslations()
  const [failed, setFailed] = useState(false)
  const showImage = !!imageUrl && !failed
  return (
    <div className="flex w-full flex-col items-center text-center">
      <div className="bg-black-500 box-shadow-book flex aspect-square w-full items-center justify-center overflow-hidden rounded-full">
        {showImage ? (
          <img src={imageUrl} alt="" loading="lazy" className="h-full w-full object-cover" onError={() => setFailed(true)} />
        ) : (
          <span className="material-symbols text-foreground-subdued/50 text-5xl" aria-hidden="true">
            person
          </span>
        )}
      </div>
      <span className="text-foreground mt-1.5 line-clamp-2 text-sm leading-snug font-semibold">{author.name}</span>
      {typeof author.numBooks === 'number' && author.numBooks > 0 && (
        <span className="text-foreground-subdued line-clamp-1 text-xs">{t('LabelMobileAuthorBookCount', { count: author.numBooks })}</span>
      )}
    </div>
  )
}
