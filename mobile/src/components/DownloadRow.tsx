import { useTypeSafeTranslations } from '../hooks/useTypeSafeTranslations'
import type { TranslationKey } from '../types/translations'
import Badge from './Badge'
import Btn from './ui/Btn'
import type { DownloadSnapshot, DownloadState } from '../downloads/downloadTypes'

const STATE_LABELS: Record<DownloadState, TranslationKey> = {
  queued: 'LabelMobileDownloadQueued',
  running: 'LabelMobileDownloadRunning',
  paused: 'LabelMobileDownloadPaused',
  waiting_for_network: 'LabelMobileDownloadWaitingForNetwork',
  waiting_for_space: 'LabelMobileDownloadWaitingForSpace',
  complete: 'LabelMobileDownloadComplete',
  failed: 'LabelMobileDownloadFailed',
  cancelled: 'LabelMobileDownloadCancelled'
}

const STATE_TONES: Partial<Record<DownloadState, 'success' | 'error' | 'info' | 'warning'>> = {
  running: 'info',
  complete: 'success',
  failed: 'error',
  cancelled: 'error',
  waiting_for_network: 'warning',
  waiting_for_space: 'warning'
}

const PAUSABLE_STATES: DownloadState[] = ['queued', 'running', 'waiting_for_network', 'waiting_for_space']
// `failed` is resumable: the native side requeues failed parts (and clears the failure) on resume.
const RESUMABLE_STATES: DownloadState[] = ['paused', 'failed']
const CANCELLABLE_STATES: DownloadState[] = ['queued', 'running', 'paused', 'waiting_for_network', 'waiting_for_space', 'failed']

interface DownloadRowProps {
  download: DownloadSnapshot
  onPause: (id: string) => void
  onResume: (id: string) => void
  onCancel: (id: string) => void
}

export default function DownloadRow({ download, onPause, onResume, onCancel }: DownloadRowProps) {
  const t = useTypeSafeTranslations()
  const canPause = PAUSABLE_STATES.includes(download.state)
  const canResume = RESUMABLE_STATES.includes(download.state)
  const canCancel = CANCELLABLE_STATES.includes(download.state)

  return (
    <div className="bg-primary border-border rounded-md border p-3" data-testid="download-row">
      <p className="text-foreground text-sm leading-snug font-semibold">{download.title}</p>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Badge tone={STATE_TONES[download.state] ?? 'neutral'}>{t(STATE_LABELS[download.state])}</Badge>
        {download.progressPercent != null && <span className="text-foreground-muted text-xs tabular-nums">{download.progressPercent}%</span>}
      </div>

      {download.progressPercent != null && (
        <div className="bg-track-bg mt-2 h-1 w-full overflow-hidden rounded-full">
          <div className="bg-accent h-full rounded-full transition-all duration-300" style={{ width: `${download.progressPercent}%` }} />
        </div>
      )}

      {download.error && <p className="text-error mt-2 text-xs">{t('MessageMobileDownloadError', { message: download.error })}</p>}

      {(canPause || canResume || canCancel) && (
        <div className="mt-3 flex gap-2">
          {canPause && (
            <Btn size="small" onClick={() => onPause(download.id)} className="justify-center">
              {t('ButtonPause')}
            </Btn>
          )}
          {canResume && (
            <Btn size="small" onClick={() => onResume(download.id)} className="justify-center">
              {t('ButtonMobileResumeDownload')}
            </Btn>
          )}
          {canCancel && (
            <Btn size="small" color="bg-error" onClick={() => onCancel(download.id)} className="justify-center">
              {t('ButtonCancel')}
            </Btn>
          )}
        </div>
      )}
    </div>
  )
}
