import type { SearchRelease, SearchResponse } from '@abs/acquisition-contract'
import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { formatAcquisitionError, type MobileAcquisitionClient } from '../api/acquisitionClient'
import { useAuth } from '../auth/AuthProvider'
import ConfirmDialog from '../components/ConfirmDialog'
import LoadingView from '../components/LoadingView'
import ReleaseCard from '../components/ReleaseCard'
import Btn from '../components/ui/Btn'
import PageMessage from '../components/ui/PageMessage'
import TextInput from '../components/ui/TextInput'
import { useAcquisition } from '../contexts/AcquisitionContext'
import { useTypeSafeTranslations } from '../hooks/useTypeSafeTranslations'

/** Minimal shape this page needs -- lets tests inject a fake implementation via AuthContext
 * without mocking the module import (mirrors the web app's DiscoverApi contract). */
export type DiscoverApi = Pick<MobileAcquisitionClient, 'searchAudiobooks' | 'createAcquisition'>

export default function DiscoverPage() {
  const t = useTypeSafeTranslations()
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
    <div>
      <h1 className="text-foreground mb-1 text-lg font-semibold">{t('LabelDiscover')}</h1>
      {/* Always visible (not a toast): acquiring is server-side, offline listening needs a separate device download. */}
      <p className="text-foreground-muted mb-3 text-sm leading-snug" data-testid="discover-explainer">
        {t('MessageMobileDiscoverExplainer')}
      </p>

      <form
        className="mb-4 flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void handleSearch()
        }}
      >
        <TextInput
          type="search"
          size="small"
          label={t('LabelSearchAudiobooks')}
          placeholder={t('LabelSearchAudiobooks')}
          value={query}
          onChange={setQuery}
          enterKeyHint="search"
          className="min-w-0 flex-1"
          clearable
          onClear={() => setQuery('')}
        />
        <Btn size="small" type="submit" color="bg-accent" disabled={!query.trim() || searching} loading={searching} className="shrink-0 justify-center">
          {t('ButtonSearch')}
        </Btn>
      </form>

      {error && (
        <p role="alert" className="text-error mb-3 text-sm">
          {error}
        </p>
      )}

      {searching && <LoadingView label={t('MessageMobileSearching')} />}

      {!searching && searchResult && searchResult.results.length === 0 && (
        <PageMessage message={t('MessageMobileNoReleasesFound')} description={t('MessageMobileNoReleasesFoundDescription')} />
      )}

      {!searching && searchResult && searchResult.results.length > 0 && (
        <div className="flex flex-col gap-2" data-testid="discover-results">
          {searchResult.results.map((release) => (
            <ReleaseCard key={release.releaseId} release={release} onAcquire={setSelected} submitting={submitting && selected?.releaseId === release.releaseId} />
          ))}
        </div>
      )}

      <ConfirmDialog
        isOpen={!!selected}
        message={selected ? t('MessageConfirmAcquisition', { 0: selected.title }) : ''}
        description={t('MessageMobileConfirmAcquisitionSteps')}
        confirmLabel={t('ButtonAcquire')}
        processing={submitting}
        onClose={() => setSelected(null)}
        onConfirm={() => void handleConfirmAcquisition()}
      />
    </div>
  )
}
