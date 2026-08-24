import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import BookCard from '../components/BookCard'
import LoadingView from '../components/LoadingView'
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

  return (
    <div className="library-page">
      <nav className="library-page-nav">
        <Link to={`/library/${encodeURIComponent(libraryId)}/discover`}>Discover</Link>
        <Link to={`/library/${encodeURIComponent(libraryId)}/acquisition-queue`}>Queue</Link>
      </nav>
      {error && <p role="alert">{error}</p>}
      {!error && !items && <LoadingView label="Loading books…" />}
      {!error && items && items.length === 0 && <p>No books in this library yet.</p>}
      {!error && items && items.length > 0 && (
        <div className="library-grid">
          {items.map((item) => (
            <BookCard key={item.id} item={item} onSelect={(selected) => navigate(`/library/${encodeURIComponent(libraryId)}/item/${encodeURIComponent(selected.id)}`)} />
          ))}
        </div>
      )}
    </div>
  )
}
