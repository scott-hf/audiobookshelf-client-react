import type { Acquisition, AcquisitionState } from '@abs/acquisition-contract'
import Badge from './Badge'
import Btn from './ui/Btn'

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

const STATUS_TONES: Partial<Record<AcquisitionState, 'success' | 'error' | 'info' | 'warning'>> = {
  available: 'success',
  failed: 'error',
  cancelled: 'error',
  needs_attention: 'warning',
  downloading: 'info',
  processing: 'info'
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
  const isIndeterminate = progress == null && IN_PROGRESS_STATES.includes(acquisition.state)

  return (
    <div className="bg-primary border-border rounded-md border p-3" data-testid="acquisition-row">
      <p className="text-foreground text-sm leading-snug font-semibold">{acquisition.title}</p>
      <p className="text-foreground-subdued text-xs">{acquisition.author}</p>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Badge tone={STATUS_TONES[acquisition.state] ?? 'neutral'}>{STATUS_LABELS[acquisition.state]}</Badge>
        {progress != null && <span className="text-foreground-muted text-xs tabular-nums">{progress}%</span>}
        {isIndeterminate && (
          <span className="text-foreground-muted text-xs" data-testid="acquisition-progress-indeterminate">
            Progress…
          </span>
        )}
      </div>

      {progress != null && (
        <div className="bg-track-bg mt-2 h-1 w-full overflow-hidden rounded-full">
          <div className="bg-accent h-full rounded-full transition-all duration-300" style={{ width: `${progress}%` }} />
        </div>
      )}

      {acquisition.error && (
        <p className="text-error mt-2 text-xs">
          Error: {acquisition.error.message}
        </p>
      )}

      {(canOpen || canRetry || canCancel) && (
        <div className="mt-3 flex gap-2">
          {canOpen && (
            <Btn size="small" to={`/library/${libraryId}/item/${acquisition.absItemId}`} color="bg-accent" className="justify-center">
              Open Book
            </Btn>
          )}
          {canRetry && (
            <Btn size="small" disabled={retrying} loading={retrying} onClick={() => onRetry(acquisition)} className="justify-center">
              Retry
            </Btn>
          )}
          {canCancel && (
            <Btn size="small" color="bg-error" disabled={cancelling} loading={cancelling} onClick={() => onCancel(acquisition)} className="justify-center">
              Cancel
            </Btn>
          )}
        </div>
      )}
    </div>
  )
}
