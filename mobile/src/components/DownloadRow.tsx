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
    <div className="download-row" data-testid="download-row">
      <div className="download-row-info">
        <p className="download-row-title">{download.title}</p>
        <div className="download-row-badges">
          <span className="badge">{STATE_LABELS[download.state]}</span>
          {download.progressPercent != null && <span className="download-row-progress-value">{download.progressPercent}%</span>}
          {download.error && <span className="badge badge-error">Error: {download.error}</span>}
        </div>
      </div>
      <div className="download-row-actions">
        {canPause && (
          <button type="button" className="download-row-button" onClick={() => onPause(download.id)}>
            Pause
          </button>
        )}
        {canResume && (
          <button type="button" className="download-row-button" onClick={() => onResume(download.id)}>
            Resume
          </button>
        )}
        {canCancel && (
          <button type="button" className="download-row-button download-row-button-danger" onClick={() => onCancel(download.id)}>
            Cancel
          </button>
        )}
      </div>
    </div>
  )
}
