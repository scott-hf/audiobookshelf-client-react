import type { SearchRelease } from '@abs/acquisition-contract'
import { useTypeSafeTranslations } from '../hooks/useTypeSafeTranslations'
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

/**
 * The wire sends the sentinel 'unknown' for a missing format (an older client may be talking to a
 * newer gateway and vice versa, so the contract keeps it a non-null string). Treat that, in any
 * case, and blank, as "no format": the caller renders no pill. `qualityLabel` is never read.
 * Mirrored in src/components/acquisition/ReleaseCard.tsx -- keep the two in step.
 */
function meaningfulFormat(format: string | null | undefined): string | null {
  const trimmed = format?.trim()
  return trimmed && trimmed.toLowerCase() !== 'unknown' ? trimmed : null
}

/** `sizeLabel` is absent (undefined) from an older gateway and null/blank when the source had none. */
function meaningfulText(text: string | null | undefined): string | null {
  const trimmed = text?.trim()
  return trimmed ? trimmed : null
}

interface ReleaseCardProps {
  release: SearchRelease
  onAcquire: (release: SearchRelease) => void
  /** Keyed by the opaque releaseId of whichever release is currently submitting, never by
   * normalized title/author -- two releases can legitimately share a title (FND-00437). */
  submitting?: boolean
}

export default function ReleaseCard({ release, onAcquire, submitting = false }: ReleaseCardProps) {
  const t = useTypeSafeTranslations()
  const canAcquire = release.requestable && !release.alreadyOwned
  const narrators = release.narrators.join(', ')
  // A real byte count wins; otherwise the source's own size string; otherwise no size pill.
  const sizeText = release.sizeBytes != null ? bytesPretty(release.sizeBytes) : meaningfulText(release.sizeLabel)
  const format = meaningfulFormat(release.format)

  return (
    <div className="bg-primary border-border rounded-md border p-3" data-testid="release-card">
      <p className="text-foreground text-sm leading-snug font-semibold">{release.title}</p>
      <p className="text-foreground-subdued text-xs">
        {release.author}
        {narrators ? ` · ${narrators}` : ''}
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {format != null && <Badge tone="info">{format.toUpperCase()}</Badge>}
        {sizeText != null && <Badge>{sizeText}</Badge>}
        {release.durationSeconds != null && <Badge>{durationPretty(release.durationSeconds)}</Badge>}
        <Badge>{release.sourceLabel}</Badge>
        {release.seeders != null && <Badge>{t('LabelSeeders', { 0: release.seeders })}</Badge>}
        {release.alreadyOwned && <Badge tone="success">{t('LabelMobileAlreadyInServerLibrary')}</Badge>}
      </div>

      <Btn
        size="small"
        color="bg-accent"
        disabled={!canAcquire || submitting}
        loading={submitting}
        onClick={() => onAcquire(release)}
        className="mt-3 w-full justify-center"
      >
        {t('ButtonAcquire')}
      </Btn>
    </div>
  )
}
