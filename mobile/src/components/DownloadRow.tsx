import Badge from './Badge'
import Btn from './ui/Btn'
import type { DownloadSnapshot, DownloadState } from '../downloads/downloadTypes'

const STATE_LABELS: Record<DownloadState, string> = {
  queued: 'Queued',
  running: 'Downloading',
  paused: 'Paused',
  waiting_for_network: 'Waiting for Wi-Fi',
  waiting_for_space: 'Waiting for storage',
  complete: 'Downloaded',
  failed: 'Failed',
  cancelled: 'Cancelled'
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
const RESUMABLE_STATES: DownloadState[] = ['paused', 'failed']
const CANCELLABLE_STATES: DownloadState[] = ['queued', 'running', 'paused', 'waiting_for_network', 'waiting_for_space', 'failed']

interface DownloadRowProps {
  download: DownloadSnapshot
  onPause: (id: string) => void
  onResume: (id: string) => void
  onCancel: (id: string) => void
}

export default function DownloadRow({ download, onPause, onResume, onCancel }: DownloadRowProps) {
  const canPause = PAUSABLE_STATES.includes(download.state)
  const canResume = RESUMABLE_STATES.includes(download.state)
  const canCancel = CANCELLABLE_STATES.includes(download.state)

  return (
    <div className="bg-primary border-border rounded-md border p-3" data-testid="download-row">
      <p className="text-foreground text-sm leading-snug font-semibold">{download.title}</p>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Badge tone={STATE_TONES[download.state] ?? 'neutral'}>{STATE_LABELS[download.state]}</Badge>
        {download.progressPercent != null && <span className="text-foreground-muted text-xs tabular-nums">{download.progressPercent}%</span>}
      </div>

      {download.progressPercent != null && (
        <div className="bg-track-bg mt-2 h-1 w-full overflow-hidden rounded-full">
          <div className="bg-accent h-full rounded-full transition-all duration-300" style={{ width: `${download.progressPercent}%` }} />
        </div>
      )}

      {download.error && <p className="text-error mt-2 text-xs">Error: {download.error}</p>}

      {(canPause || canResume || canCancel) && (
        <div className="mt-3 flex gap-2">
          {canPause && (
            <Btn size="small" onClick={() => onPause(download.id)} className="justify-center">
              Pause
            </Btn>
          )}
          {canResume && (
            <Btn size="small" onClick={() => onResume(download.id)} className="justify-center">
              Resume
            </Btn>
          )}
          {canCancel && (
            <Btn size="small" color="bg-error" onClick={() => onCancel(download.id)} className="justify-center">
              Cancel
            </Btn>
          )}
        </div>
      )}
    </div>
  )
}
