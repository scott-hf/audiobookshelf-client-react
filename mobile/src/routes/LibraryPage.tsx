import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
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
  if (error) return <p role="alert">{error}</p>
  if (!items) return <LoadingView label="Loading books…" />
  if (items.length === 0) return <p>No books in this library yet.</p>

  return (
    <div className="library-grid">
      {items.map((item) => (
        <BookCard key={item.id} item={item} onSelect={(selected) => navigate(`/library/${encodeURIComponent(libraryId)}/item/${encodeURIComponent(selected.id)}`)} />
      ))}
    </div>
  )
}
