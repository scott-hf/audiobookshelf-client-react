import type { Acquisition, AcquisitionState } from '@abs/acquisition-contract'
import { useTypeSafeTranslations } from '../hooks/useTypeSafeTranslations'
import type { TranslationKey } from '../types/translations'
import Badge from './Badge'
import Btn from './ui/Btn'

/** All of these describe the SERVER's progress acquiring the book, not anything on this device. The
 * `downloading` and `available` states deliberately avoid the bare words "Downloading"/"Available"
 * (the generic StatusAcquisition* catalog values), which read as device downloads / offline availability. */
const STATUS_LABEL_KEYS: Record<AcquisitionState, TranslationKey> = {
  queued: 'StatusAcquisitionQueued',
  submitted: 'StatusAcquisitionSubmitted',
  downloading: 'LabelMobileAcquisitionFetching',
  processing: 'StatusAcquisitionProcessing',
  staged: 'StatusAcquisitionStaged',
  importing: 'StatusAcquisitionImporting',
  scanning: 'StatusAcquisitionScanning',
  available: 'LabelMobileAcquisitionAvailable',
  failed: 'StatusAcquisitionFailed',
  cancelled: 'StatusAcquisitionCancelled',
  needs_attention: 'StatusAcquisitionNeedsAttention'
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
  const t = useTypeSafeTranslations()
  const progress = acquisition.progressPercent == null ? null : Math.min(100, Math.max(0, acquisition.progressPercent))
  const isAvailable = acquisition.state === 'available'
  // The server hands back the library item id once it has imported the book; without it there is no
  // way to resolve the item, so the row falls back to wording only (no link is invented).
  const canOpen = isAvailable && !!acquisition.absItemId
  const canRetry = acquisition.state === 'failed' && acquisition.error?.retryable === true
  const canCancel = CANCELLABLE_STATES.includes(acquisition.state)
  const isIndeterminate = progress == null && IN_PROGRESS_STATES.includes(acquisition.state)

  return (
    <div className="bg-primary border-border rounded-md border p-3" data-testid="acquisition-row">
      <p className="text-foreground text-sm leading-snug font-semibold">{acquisition.title}</p>
      <p className="text-foreground-subdued text-xs">{acquisition.author}</p>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Badge tone={STATUS_TONES[acquisition.state] ?? 'neutral'}>{t(STATUS_LABEL_KEYS[acquisition.state])}</Badge>
        {progress != null && <span className="text-foreground-muted text-xs tabular-nums">{progress}%</span>}
        {isIndeterminate && (
          <span className="text-foreground-muted text-xs" data-testid="acquisition-progress-indeterminate">
            {t('LabelMobileProgressPending')}
          </span>
        )}
      </div>

      {progress != null && (
        <div className="bg-track-bg mt-2 h-1 w-full overflow-hidden rounded-full">
          <div className="bg-accent h-full rounded-full transition-all duration-300" style={{ width: `${progress}%` }} />
        </div>
      )}

      {acquisition.error && <p className="text-error mt-2 text-xs">{t('MessageMobileAcquisitionError', { message: acquisition.error.message })}</p>}

      {isAvailable && (
        <p className="text-foreground-muted mt-2 text-xs leading-snug" data-testid="acquisition-next-step">
          {canOpen ? t('MessageMobileAcquisitionAvailableNextStep') : t('MessageMobileAcquisitionAvailableNextStepNoLink')}
        </p>
      )}

      {(canOpen || canRetry || canCancel) && (
        <div className="mt-3 flex gap-2">
          {canOpen && (
            <Btn size="small" to={`/library/${libraryId}/item/${acquisition.absItemId}`} color="bg-accent" className="justify-center">
              {t('ButtonMobileOpenBookToDownload')}
            </Btn>
          )}
          {canRetry && (
            <Btn size="small" disabled={retrying} loading={retrying} onClick={() => onRetry(acquisition)} className="justify-center">
              {t('ButtonRetry')}
            </Btn>
          )}
          {canCancel && (
            <Btn size="small" color="bg-error" disabled={cancelling} loading={cancelling} onClick={() => onCancel(acquisition)} className="justify-center">
              {t('ButtonCancel')}
            </Btn>
          )}
        </div>
      )}
    </div>
  )
}
