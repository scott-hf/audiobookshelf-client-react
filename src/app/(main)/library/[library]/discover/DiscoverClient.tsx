'use client'

import ReleaseCard from '@/components/acquisition/ReleaseCard'
import Btn from '@/components/ui/Btn'
import PageMessage from '@/components/ui/PageMessage'
import TextInput from '@/components/ui/TextInput'
import ConfirmDialog from '@/components/widgets/ConfirmDialog'
import LoadingSpinner from '@/components/widgets/LoadingSpinner'
import { useAcquisition } from '@/contexts/AcquisitionContext'
import { useGlobalToast } from '@/contexts/ToastContext'
import { useTypeSafeTranslations } from '@/hooks/useTypeSafeTranslations'
import { acquisitionClient, formatAcquisitionError } from '@/lib/acquisition'
import type { SearchRelease, SearchResponse } from '@abs/acquisition-contract'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

/** Minimal shape of the acquisition client this component needs -- lets Cypress inject a fake
 * implementation without mocking the module import. */
export interface DiscoverApi {
  searchAudiobooks: typeof acquisitionClient.searchAudiobooks
  createAcquisition: typeof acquisitionClient.createAcquisition
}

interface DiscoverClientProps {
  libraryId: string
  api?: DiscoverApi
}

export default function DiscoverClient({ libraryId, api = acquisitionClient }: DiscoverClientProps) {
  const t = useTypeSafeTranslations()
  const router = useRouter()
  const { showToast } = useGlobalToast()
  const { applyAcquisition } = useAcquisition()

  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchResult, setSearchResult] = useState<SearchResponse | null>(null)
  const [selected, setSelected] = useState<SearchRelease | null>(null)
  const [submittingReleaseId, setSubmittingReleaseId] = useState<string | null>(null)

  const handleSearch = async () => {
    const trimmed = query.trim()
    if (!trimmed || searching) return

    setSearching(true)
    try {
      const response = await api.searchAudiobooks(libraryId, trimmed)
      setSearchResult(response)
    } catch (error) {
      console.error('Audiobook search failed', error)
      showToast(formatAcquisitionError(error, t), { type: 'error' })
      setSearchResult(null)
    } finally {
      setSearching(false)
    }
  }

  const handleConfirmAcquisition = async () => {
    if (!selected || !searchResult) return

    setSubmittingReleaseId(selected.releaseId)
    try {
      const acquisition = await api.createAcquisition(libraryId, {
        searchSessionId: searchResult.searchSessionId,
        releaseId: selected.releaseId,
        idempotencyKey: crypto.randomUUID()
      })
      applyAcquisition(libraryId, acquisition)
      showToast(t('MessageAcquisitionQueued'), { type: 'success' })
      router.push(`/library/${libraryId}/acquisition-queue`)
    } catch (error) {
      console.error('Failed to create acquisition', error)
      showToast(formatAcquisitionError(error, t), { type: 'error' })
    } finally {
      setSubmittingReleaseId(null)
      setSelected(null)
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-2 md:p-6">
      <h1 className="text-xl">{t('LabelDiscover')}</h1>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex-1">
          <TextInput
            label={t('LabelSearchAudiobooks')}
            value={query}
            onChange={setQuery}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void handleSearch()
              }
            }}
            clearable
            placeholder={t('LabelSearchAudiobooks')}
          />
        </div>
        <Btn loading={searching} disabled={!query.trim()} onClick={() => void handleSearch()}>
          {t('ButtonSearch')}
        </Btn>
      </div>

      {searching && (
        <div className="flex items-center justify-center py-10">
          <LoadingSpinner size="la-lg" />
        </div>
      )}

      {!searching && searchResult && searchResult.results.length === 0 && <PageMessage message={t('MessageNoDiscoverResults')} />}

      {!searching && searchResult && searchResult.results.length > 0 && (
        <div className="flex flex-col gap-2" cy-id="discover-results">
          {searchResult.results.map((release) => (
            <ReleaseCard key={release.releaseId} release={release} onAcquire={() => setSelected(release)} submitting={submittingReleaseId === release.releaseId} />
          ))}
        </div>
      )}

      <ConfirmDialog
        isOpen={!!selected}
        message={selected ? t('MessageConfirmAcquisition', { 0: selected.title }) : ''}
        yesButtonText={t('ButtonConfirmAcquisition')}
        processing={!!submittingReleaseId}
        onClose={() => setSelected(null)}
        onConfirm={() => void handleConfirmAcquisition()}
      />
    </div>
  )
}
