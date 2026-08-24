import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import LoadingView from '../components/LoadingView'
import type { AbsLibraryItem } from '../types/abs'

export default function BookDetailsPage() {
  const { libraryId, itemId } = useParams<{ libraryId: string; itemId: string }>()
  const { client } = useAuth()
  const [item, setItem] = useState<AbsLibraryItem | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!itemId) return
    let cancelled = false
    setItem(null)
    client
      .getLibraryItem(itemId)
      .then((result) => {
        if (!cancelled) setItem(result)
      })
      .catch(() => {
        if (!cancelled) setError('Could not load this book.')
      })
    return () => {
      cancelled = true
    }
  }, [client, itemId])

  if (!itemId || !libraryId) return null
  if (error) return <p role="alert">{error}</p>
  if (!item) return <LoadingView label="Loading book…" />

  const { metadata, duration } = item.media
  const progress = item.userMediaProgress

  return (
    <article className="book-details">
      <h2>{metadata.title}</h2>
      {metadata.authorName && <p className="book-details-author">{metadata.authorName}</p>}
      {metadata.description && <p className="book-details-description">{metadata.description}</p>}
      {typeof duration === 'number' && <p className="book-details-duration">{Math.round(duration / 60)} min</p>}
      {progress && !progress.isFinished && progress.currentTime > 0 && <p>Resume from {Math.round(progress.currentTime / 60)} min</p>}
      <Link className="book-details-play" to={`/library/${encodeURIComponent(libraryId)}/item/${encodeURIComponent(itemId)}/play`}>
        Play
      </Link>
    </article>
  )
}
