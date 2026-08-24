import type { Acquisition, AcquisitionState } from '@abs/acquisition-contract'
import { Link } from 'react-router-dom'

const STATUS_LABELS: Record<AcquisitionState, string> = {
  queued: 'Queued',
  submitted: 'Submitted',
  downloading: 'Downloading',
  processing: 'Processing',
  staged: 'Staged',
  importing: 'Importing',
  scanning: 'Scanning',
  available: 'Available',
  failed: 'Failed',
  cancelled: 'Cancelled',
  needs_attention: 'Needs attention'
}

/** Active states a queued acquisition can still be pulled out of before it finishes. */
const CANCELLABLE_STATES: AcquisitionState[] = ['queued', 'submitted', 'downloading', 'processing', 'staged']

/** States with real progress under way -- shown with an indeterminate marker when the gateway
 * has not reported a percent yet. */
const IN_PROGRESS_STATES: AcquisitionState[] = ['downloading', 'processing']

interface AcquisitionRowProps {
  libraryId: string
  acquisition: Acquisition
  onRetry: (acquisition: Acquisition) => void
  onCancel: (acquisition: Acquisition) => void
  /** Keyed by the opaque acquisition.id of whichever row is in flight, never by normalized
   * title (FND-00437). */
  retrying?: boolean
  cancelling?: boolean
}

export default function AcquisitionRow({ libraryId, acquisition, onRetry, onCancel, retrying = false, cancelling = false }: AcquisitionRowProps) {
  const progress = acquisition.progressPercent == null ? null : Math.min(100, Math.max(0, acquisition.progressPercent))
  const canOpen = acquisition.state === 'available' && !!acquisition.absItemId
  const canRetry = acquisition.state === 'failed' && acquisition.error?.retryable === true
  const canCancel = CANCELLABLE_STATES.includes(acquisition.state)

  return (
    <div className="acquisition-row" data-testid="acquisition-row">
      <div className="acquisition-row-info">
        <p className="acquisition-row-title">{acquisition.title}</p>
        <p className="acquisition-row-author">{acquisition.author}</p>
        <div className="acquisition-row-badges">
          <span className="badge">{STATUS_LABELS[acquisition.state]}</span>
          {progress != null && <span className="acquisition-row-progress-value">{progress}%</span>}
          {progress == null && IN_PROGRESS_STATES.includes(acquisition.state) && (
            <span className="acquisition-row-progress-value" data-testid="acquisition-progress-indeterminate">
              Progress…
            </span>
          )}
          {acquisition.error && <span className="badge badge-error">Error: {acquisition.error.message}</span>}
        </div>
      </div>
      <div className="acquisition-row-actions">
        {canOpen && (
          <Link className="acquisition-row-button" to={`/library/${libraryId}/item/${acquisition.absItemId}`}>
            Open Book
          </Link>
        )}
        {canRetry && (
          <button type="button" className="acquisition-row-button" disabled={retrying} onClick={() => onRetry(acquisition)}>
            {retrying ? 'Working…' : 'Retry'}
          </button>
        )}
        {canCancel && (
          <button type="button" className="acquisition-row-button acquisition-row-button-danger" disabled={cancelling} onClick={() => onCancel(acquisition)}>
            {cancelling ? 'Working…' : 'Cancel'}
          </button>
        )}
      </div>
    </div>
  )
}
