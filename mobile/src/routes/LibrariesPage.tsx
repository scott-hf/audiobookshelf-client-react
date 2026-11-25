import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import LoadingView from '../components/LoadingView'
import PageMessage from '../components/ui/PageMessage'
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

  // Most servers have exactly one book library, and a list with a single row is a tap that
  // tells the user nothing. Skip straight to it.
  const soleLibraryId = libraries?.length === 1 ? libraries[0].id : null

  useEffect(() => {
    // `replace`, not push: otherwise Back from the library lands here and this effect
    // immediately throws the user forward again, trapping them on the library screen.
    if (soleLibraryId) navigate(`/library/${encodeURIComponent(soleLibraryId)}`, { replace: true })
  }, [soleLibraryId, navigate])

  if (error)
    return (
      <p role="alert" className="text-error py-10 text-center">
        {error}
      </p>
    )
  if (!libraries) return <LoadingView label="Loading libraries…" />
  if (libraries.length === 0) return <PageMessage message="No book libraries available." description="Add a book library on your Audiobookshelf server to see it here." />
  // The redirect above lands on the next render; showing the one-row list in the meantime
  // would flash a list the user is never meant to see.
  if (soleLibraryId) return <LoadingView label="Loading libraries…" />

  return (
    <>
      <h2 className="text-foreground-muted mb-3 text-xs font-semibold tracking-widest uppercase">Libraries</h2>
      <ul className="flex flex-col gap-2">
        {libraries.map((library) => (
          <li key={library.id}>
            <button
              type="button"
              className="bg-primary border-border hover:bg-bg-hover focus-visible:outline-foreground-muted flex w-full items-center gap-3 rounded-md border px-4 py-3 text-start transition-colors focus-visible:outline-1"
              onClick={() => navigate(`/library/${encodeURIComponent(library.id)}`)}
            >
              <span className="abs-icons icon-books-1 text-accent text-xl" aria-hidden="true" />
              <span className="text-foreground flex-1 font-semibold">{library.name}</span>
              <span className="material-symbols text-foreground-subdued text-xl" aria-hidden="true">
                chevron_right
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  )
}
