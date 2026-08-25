import type { SearchRelease } from '@abs/acquisition-contract'
import Badge from './Badge'
import Btn from './ui/Btn'

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
    <div className="bg-primary border-border rounded-md border p-3" data-testid="release-card">
      <p className="text-foreground text-sm leading-snug font-semibold">{release.title}</p>
      <p className="text-foreground-subdued text-xs">
        {release.author}
        {narrators ? ` · ${narrators}` : ''}
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Badge tone="info">{release.format.toUpperCase()}</Badge>
        {release.sizeBytes != null && <Badge>{bytesPretty(release.sizeBytes)}</Badge>}
        {release.durationSeconds != null && <Badge>{durationPretty(release.durationSeconds)}</Badge>}
        <Badge>{release.sourceLabel}</Badge>
        <Badge>{release.qualityLabel}</Badge>
        {release.seeders != null && <Badge>{release.seeders} seeders</Badge>}
        {release.alreadyOwned && <Badge tone="success">Already owned</Badge>}
      </div>

      <Btn
        size="small"
        color="bg-accent"
        disabled={!canAcquire || submitting}
        loading={submitting}
        onClick={() => onAcquire(release)}
        className="mt-3 w-full justify-center"
      >
        Acquire
      </Btn>
    </div>
  )
}
