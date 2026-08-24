'use client'

import Btn from '@/components/ui/Btn'
import { useTypeSafeTranslations } from '@/hooks/useTypeSafeTranslations'
import type { TranslationKey } from '@/types/translations'
import type { Acquisition, AcquisitionState } from '@abs/acquisition-contract'

const STATUS_MESSAGE_KEYS: Record<AcquisitionState, TranslationKey> = {
  queued: 'StatusAcquisitionQueued',
  submitted: 'StatusAcquisitionSubmitted',
  downloading: 'StatusAcquisitionDownloading',
  processing: 'StatusAcquisitionProcessing',
  staged: 'StatusAcquisitionStaged',
  importing: 'StatusAcquisitionImporting',
  scanning: 'StatusAcquisitionScanning',
  available: 'StatusAcquisitionAvailable',
  failed: 'StatusAcquisitionFailed',
  cancelled: 'StatusAcquisitionCancelled',
  needs_attention: 'StatusAcquisitionNeedsAttention'
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
  retrying?: boolean
  cancelling?: boolean
}

export default function AcquisitionRow({ libraryId, acquisition, onRetry, onCancel, retrying = false, cancelling = false }: AcquisitionRowProps) {
  const t = useTypeSafeTranslations()

  const progress = acquisition.progressPercent == null ? null : Math.min(100, Math.max(0, acquisition.progressPercent))
  const canOpen = acquisition.state === 'available' && !!acquisition.absItemId
  const canRetry = acquisition.state === 'failed' && acquisition.error?.retryable === true
  const canCancel = CANCELLABLE_STATES.includes(acquisition.state)

  return (
    <div className="bg-bg border-border flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between" cy-id="acquisition-row">
      <div className="min-w-0 flex-1">
        <p className="text-foreground truncate text-base font-semibold">{acquisition.title}</p>
        <p className="text-foreground-muted truncate text-sm">{acquisition.author}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="bg-bg-alt text-foreground-muted inline-flex items-center rounded-md px-2 py-0.5 text-xs whitespace-nowrap">
            {t(STATUS_MESSAGE_KEYS[acquisition.state])}
          </span>
          {progress != null && <span className="text-foreground-muted text-xs">{progress}%</span>}
          {progress == null && IN_PROGRESS_STATES.includes(acquisition.state) && (
            <span className="text-foreground-muted text-xs" cy-id="acquisition-progress-indeterminate">
              {t('LabelProgress')}…
            </span>
          )}
          {acquisition.error && (
            <span className="bg-error/20 text-error inline-flex items-center rounded-md px-2 py-0.5 text-xs whitespace-nowrap">
              {t('LabelError')}: {acquisition.error.message}
            </span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 self-end sm:self-auto">
        {canOpen && (
          <Btn size="small" to={`/library/${libraryId}/item/${acquisition.absItemId}`}>
            {t('ButtonOpenBook')}
          </Btn>
        )}
        {canRetry && (
          <Btn size="small" loading={retrying} disabled={retrying} onClick={() => onRetry(acquisition)}>
            {t('ButtonRetry')}
          </Btn>
        )}
        {canCancel && (
          <Btn size="small" color="bg-error" loading={cancelling} disabled={cancelling} onClick={() => onCancel(acquisition)}>
            {t('ButtonCancel')}
          </Btn>
        )}
      </div>
    </div>
  )
}
