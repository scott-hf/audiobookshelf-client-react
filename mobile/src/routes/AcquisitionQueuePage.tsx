import type { Acquisition } from '@abs/acquisition-contract'
import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { formatAcquisitionError, type MobileAcquisitionClient } from '../api/acquisitionClient'
import { useAuth } from '../auth/AuthProvider'
import AcquisitionRow from '../components/AcquisitionRow'
import ConfirmDialog from '../components/ConfirmDialog'
import LoadingView from '../components/LoadingView'
import { useAcquisition } from '../contexts/AcquisitionContext'

/** Minimal shape this page needs -- mirrors DiscoverPage's DiscoverApi pattern so tests can
 * inject a fake implementation via AuthContext. */
export type AcquisitionQueueApi = Pick<MobileAcquisitionClient, 'retryAcquisition' | 'cancelAcquisition'>

export default function AcquisitionQueuePage() {
  const { libraryId } = useParams<{ libraryId: string }>()
  const { acquisitionClient } = useAuth()
  const { getQueue, ensureQueueLoaded, applyAcquisition } = useAcquisition()
  const api: AcquisitionQueueApi | null = acquisitionClient

  const [error, setError] = useState<string | null>(null)
  const [retryingId, setRetryingId] = useState<string | null>(null)
  const [cancellingId, setCancellingId] = useState<string | null>(null)
  const [pendingCancel, setPendingCancel] = useState<Acquisition | null>(null)

  useEffect(() => {
    if (libraryId) ensureQueueLoaded(libraryId)
  }, [libraryId, ensureQueueLoaded])

  if (!libraryId || !api) return null

  const queue = getQueue(libraryId)

  const handleRetry = async (acquisition: Acquisition) => {
    setRetryingId(acquisition.id)
    setError(null)
    try {
      const updated = await api.retryAcquisition(acquisition.id)
      applyAcquisition(libraryId, updated)
    } catch (err) {
      console.error('Failed to retry acquisition', err)
      setError(formatAcquisitionError(err))
    } finally {
      setRetryingId(null)
    }
  }

  const handleConfirmCancel = async () => {
    if (!pendingCancel) return
    const acquisition = pendingCancel
    setCancellingId(acquisition.id)
    setError(null)
    try {
      const updated = await api.cancelAcquisition(acquisition.id)
      applyAcquisition(libraryId, updated)
    } catch (err) {
      console.error('Failed to cancel acquisition', err)
      setError(formatAcquisitionError(err))
    } finally {
      setCancellingId(null)
      setPendingCancel(null)
    }
  }

  if (queue === undefined) {
    return <LoadingView label="Loading queue…" />
  }

  return (
    <div className="acquisition-queue-page">
      <h1>Acquisition Queue</h1>

      {error && (
        <p role="alert" className="discover-error">
          {error}
        </p>
      )}

      {queue.length === 0 ? (
        <p>Nothing queued yet.</p>
      ) : (
        <div className="acquisition-queue-list" data-testid="acquisition-queue">
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
        message="Cancel this acquisition?"
        confirmLabel="Yes, cancel"
        confirmClassName="confirm-dialog-confirm confirm-dialog-danger"
        processing={!!cancellingId}
        onClose={() => setPendingCancel(null)}
        onConfirm={() => void handleConfirmCancel()}
      />
    </div>
  )
}
