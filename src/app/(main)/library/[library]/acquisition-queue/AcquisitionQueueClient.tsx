'use client'

import AcquisitionRow from '@/components/acquisition/AcquisitionRow'
import PageMessage from '@/components/ui/PageMessage'
import ConfirmDialog from '@/components/widgets/ConfirmDialog'
import LoadingSpinner from '@/components/widgets/LoadingSpinner'
import { useAcquisition } from '@/contexts/AcquisitionContext'
import { useGlobalToast } from '@/contexts/ToastContext'
import { useTypeSafeTranslations } from '@/hooks/useTypeSafeTranslations'
import { acquisitionClient, formatAcquisitionError } from '@/lib/acquisition'
import type { Acquisition } from '@abs/acquisition-contract'
import { useEffect, useState } from 'react'

/** Minimal shape of the acquisition client this component needs -- lets Cypress inject a fake
 * implementation without mocking the module import (mirrors DiscoverClient's DiscoverApi). */
export interface AcquisitionQueueApi {
  retryAcquisition: typeof acquisitionClient.retryAcquisition
  cancelAcquisition: typeof acquisitionClient.cancelAcquisition
}

interface AcquisitionQueueClientProps {
  libraryId: string
  api?: AcquisitionQueueApi
}

export default function AcquisitionQueueClient({ libraryId, api = acquisitionClient }: AcquisitionQueueClientProps) {
  const t = useTypeSafeTranslations()
  const { showToast } = useGlobalToast()
  const { getQueue, ensureQueueLoaded, applyAcquisition } = useAcquisition()

  const [retryingId, setRetryingId] = useState<string | null>(null)
  const [cancellingId, setCancellingId] = useState<string | null>(null)
  const [pendingCancel, setPendingCancel] = useState<Acquisition | null>(null)

  useEffect(() => {
    ensureQueueLoaded(libraryId)
  }, [libraryId, ensureQueueLoaded])

  const queue = getQueue(libraryId)

  const handleRetry = async (acquisition: Acquisition) => {
    setRetryingId(acquisition.id)
    try {
      const updated = await api.retryAcquisition(acquisition.id)
      applyAcquisition(libraryId, updated)
    } catch (error) {
      console.error('Failed to retry acquisition', error)
      showToast(formatAcquisitionError(error, t), { type: 'error' })
    } finally {
      setRetryingId(null)
    }
  }

  const handleConfirmCancel = async () => {
    if (!pendingCancel) return
    const acquisition = pendingCancel
    setCancellingId(acquisition.id)
    try {
      const updated = await api.cancelAcquisition(acquisition.id)
      applyAcquisition(libraryId, updated)
    } catch (error) {
      console.error('Failed to cancel acquisition', error)
      showToast(formatAcquisitionError(error, t), { type: 'error' })
    } finally {
      setCancellingId(null)
      setPendingCancel(null)
    }
  }

  if (queue === undefined) {
    return (
      <div className="flex items-center justify-center py-10">
        <LoadingSpinner size="la-lg" />
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-2 md:p-6">
      <h1 className="text-xl">{t('HeaderAcquisitionQueue')}</h1>

      {queue.length === 0 ? (
        <PageMessage message={t('MessageAcquisitionQueueEmpty')} />
      ) : (
        <div className="flex flex-col gap-2" cy-id="acquisition-queue">
          {queue.map((acquisition) => (
            <AcquisitionRow
              key={acquisition.id}
              libraryId={libraryId}
              acquisition={acquisition}
              onRetry={(a) => void handleRetry(a)}
              onCancel={setPendingCancel}
              retrying={retryingId === acquisition.id}
              cancelling={cancellingId === acquisition.id}
            />
          ))}
        </div>
      )}

      <ConfirmDialog
        isOpen={!!pendingCancel}
        message={t('MessageConfirmCancelAcquisition')}
        yesButtonText={t('ButtonYes')}
        yesButtonClassName="bg-error text-white"
        processing={!!cancellingId}
        onClose={() => setPendingCancel(null)}
        onConfirm={() => void handleConfirmCancel()}
      />
    </div>
  )
}
