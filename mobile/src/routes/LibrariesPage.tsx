import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import LoadingView from '../components/LoadingView'
import type { AbsLibrary } from '../types/abs'

export default function LibrariesPage() {
  const { client } = useAuth()
  const navigate = useNavigate()
  const [libraries, setLibraries] = useState<AbsLibrary[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    client
      .getLibraries()
      .then((response) => {
        if (!cancelled) setLibraries(response.libraries.filter((library) => library.mediaType === 'book'))
      })
      .catch(() => {
        if (!cancelled) setError('Could not load libraries.')
      })
    return () => {
      cancelled = true
    }
  }, [client])

  if (error) return <p role="alert">{error}</p>
  if (!libraries) return <LoadingView label="Loading libraries…" />
  if (libraries.length === 0) return <p>No book libraries available.</p>

  return (
    <ul className="library-list">
      {libraries.map((library) => (
        <li key={library.id}>
          <button type="button" className="library-list-item" onClick={() => navigate(`/library/${encodeURIComponent(library.id)}`)}>
            {library.name}
          </button>
        </li>
      ))}
    </ul>
  )
}
