import type { SearchRelease } from '@abs/acquisition-contract'

function bytesPretty(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`
}

function durationPretty(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.round((seconds % 3600) / 60)
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
}

interface ReleaseCardProps {
  release: SearchRelease
  onAcquire: (release: SearchRelease) => void
  /** Keyed by the opaque releaseId of whichever release is currently submitting, never by
   * normalized title/author -- two releases can legitimately share a title (FND-00437). */
  submitting?: boolean
}

export default function ReleaseCard({ release, onAcquire, submitting = false }: ReleaseCardProps) {
  const canAcquire = release.requestable && !release.alreadyOwned
  const narrators = release.narrators.join(', ')

  return (
    <div className="release-card" data-testid="release-card">
      <div className="release-card-info">
        <p className="release-card-title">{release.title}</p>
        <p className="release-card-author">
          {release.author}
          {narrators ? ` · ${narrators}` : ''}
        </p>
        <div className="release-card-badges">
          <span className="badge">{release.format.toUpperCase()}</span>
          {release.sizeBytes != null && <span className="badge">{bytesPretty(release.sizeBytes)}</span>}
          {release.durationSeconds != null && <span className="badge">{durationPretty(release.durationSeconds)}</span>}
          <span className="badge">{release.sourceLabel}</span>
          <span className="badge">{release.qualityLabel}</span>
          {release.seeders != null && <span className="badge">{release.seeders} seeders</span>}
          {release.alreadyOwned && <span className="badge badge-success">Already owned</span>}
        </div>
      </div>
      <button type="button" className="release-card-acquire" disabled={!canAcquire || submitting} onClick={() => onAcquire(release)}>
        {submitting ? 'Working…' : 'Acquire'}
      </button>
    </div>
  )
}
