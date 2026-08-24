import type { SearchRelease, SearchResponse } from '@abs/acquisition-contract'
import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { formatAcquisitionError, type MobileAcquisitionClient } from '../api/acquisitionClient'
import { useAuth } from '../auth/AuthProvider'
import ConfirmDialog from '../components/ConfirmDialog'
import LoadingView from '../components/LoadingView'
import ReleaseCard from '../components/ReleaseCard'
import { useAcquisition } from '../contexts/AcquisitionContext'

/** Minimal shape this page needs -- lets tests inject a fake implementation via AuthContext
 * without mocking the module import (mirrors the web app's DiscoverApi contract). */
export type DiscoverApi = Pick<MobileAcquisitionClient, 'searchAudiobooks' | 'createAcquisition'>

export default function DiscoverPage() {
  const { libraryId } = useParams<{ libraryId: string }>()
  const navigate = useNavigate()
  const { acquisitionClient } = useAuth()
  const { applyAcquisition } = useAcquisition()
  const api: DiscoverApi | null = acquisitionClient

  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searchResult, setSearchResult] = useState<SearchResponse | null>(null)
  const [selected, setSelected] = useState<SearchRelease | null>(null)
  const [submitting, setSubmitting] = useState(false)

  if (!libraryId || !api) return null

  const handleSearch = async () => {
    const trimmed = query.trim()
    if (!trimmed || searching) return
    setSearching(true)
    setError(null)
    try {
      const response = await api.searchAudiobooks(libraryId, trimmed)
      setSearchResult(response)
    } catch (err) {
      console.error('Audiobook search failed', err)
      setError(formatAcquisitionError(err))
      setSearchResult(null)
    } finally {
      setSearching(false)
    }
  }

  const handleConfirmAcquisition = async () => {
    if (!selected || !searchResult) return
    setSubmitting(true)
    try {
      const acquisition = await api.createAcquisition(libraryId, {
        searchSessionId: searchResult.searchSessionId,
        releaseId: selected.releaseId,
        idempotencyKey: crypto.randomUUID()
      })
      applyAcquisition(libraryId, acquisition)
      navigate(`/library/${libraryId}/acquisition-queue`)
    } catch (err) {
      console.error('Failed to create acquisition', err)
      setError(formatAcquisitionError(err))
    } finally {
      setSubmitting(false)
      setSelected(null)
    }
  }

  return (
    <div className="discover-page">
      <h1>Discover</h1>

      <form
        className="discover-search"
        onSubmit={(e) => {
          e.preventDefault()
          void handleSearch()
        }}
      >
        <input type="search" aria-label="Search audiobooks" placeholder="Search audiobooks" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button type="submit" disabled={!query.trim() || searching}>
          {searching ? 'Searching…' : 'Search'}
        </button>
      </form>

      {error && (
        <p role="alert" className="discover-error">
          {error}
        </p>
      )}

      {searching && <LoadingView label="Searching…" />}

      {!searching && searchResult && searchResult.results.length === 0 && <p>No releases found.</p>}

      {!searching && searchResult && searchResult.results.length > 0 && (
        <div className="discover-results" data-testid="discover-results">
          {searchResult.results.map((release) => (
            <ReleaseCard key={release.releaseId} release={release} onAcquire={setSelected} submitting={submitting && selected?.releaseId === release.releaseId} />
          ))}
        </div>
      )}

      <ConfirmDialog
        isOpen={!!selected}
        message={selected ? `Acquire "${selected.title}"?` : ''}
        confirmLabel="Acquire"
        processing={submitting}
        onClose={() => setSelected(null)}
        onConfirm={() => void handleConfirmAcquisition()}
      />
    </div>
  )
}
