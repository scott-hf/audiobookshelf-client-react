import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import BookCard from '../components/BookCard'
import LoadingView from '../components/LoadingView'
import PageMessage from '../components/ui/PageMessage'
import type { AbsLibraryItem } from '../types/abs'

export default function LibraryPage() {
  const { libraryId } = useParams<{ libraryId: string }>()
  const { client } = useAuth()
  const navigate = useNavigate()
  const [items, setItems] = useState<AbsLibraryItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!libraryId) return
    let cancelled = false
    setItems(null)
    client
      .getLibraryItems(libraryId)
      .then((response) => {
        if (!cancelled) setItems(response.results)
      })
      .catch(() => {
        if (!cancelled) setError('Could not load this library.')
      })
    return () => {
      cancelled = true
    }
  }, [client, libraryId])

  if (!libraryId) return null

  const libraryPath = `/library/${encodeURIComponent(libraryId)}`

  return (
    <div>
      <nav className="mb-4 flex gap-2" aria-label="Library actions">
        <Link
          to={`${libraryPath}/discover`}
          className="bg-primary border-border text-foreground hover:bg-bg-hover flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors"
        >
          <span className="material-symbols text-base" aria-hidden="true">
            travel_explore
          </span>
          Discover
        </Link>
        <Link
          to={`${libraryPath}/acquisition-queue`}
          className="bg-primary border-border text-foreground hover:bg-bg-hover flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors"
        >
          <span className="material-symbols text-base" aria-hidden="true">
            playlist_add_check
          </span>
          Queue
        </Link>
      </nav>

      {error && (
        <p role="alert" className="text-error py-10 text-center">
          {error}
        </p>
      )}
      {!error && !items && <LoadingView label="Loading books…" />}
      {!error && items && items.length === 0 && <PageMessage message="No books in this library yet." />}
      {!error && items && items.length > 0 && (
        <div className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4">
          {items.map((item) => (
            <BookCard
              key={item.id}
              item={item}
              coverUrl={client.authorizedStreamUrl(`/api/items/${encodeURIComponent(item.id)}/cover`)}
              onSelect={(selected) => navigate(`${libraryPath}/item/${encodeURIComponent(selected.id)}`)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
