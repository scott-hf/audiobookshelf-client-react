'use client'

import Btn from '@/components/ui/Btn'
import { useTypeSafeTranslations } from '@/hooks/useTypeSafeTranslations'
import { formatDuration } from '@/lib/formatDuration'
import { mergeClasses } from '@/lib/merge-classes'
import { bytesPretty } from '@/lib/string'
import type { SearchRelease } from '@abs/acquisition-contract'

interface ReleaseCardProps {
  release: SearchRelease
  onAcquire: () => void
  submitting?: boolean
  className?: string
}

/**
 * The wire sends the sentinel 'unknown' for a missing format (an older client may be talking to a
 * newer gateway and vice versa, so the contract keeps it a non-null string). Treat that, in any
 * case, and blank, as "no format": the caller renders no pill. `qualityLabel` is never read.
 * Mirrored in mobile/src/components/ReleaseCard.tsx -- keep the two in step.
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

function DetailBadge({ children }: { children: React.ReactNode }) {
  return <span className="bg-bg-alt text-foreground-muted inline-flex items-center rounded-md px-2 py-0.5 text-xs whitespace-nowrap">{children}</span>
}

export default function ReleaseCard({ release, onAcquire, submitting = false, className }: ReleaseCardProps) {
  const t = useTypeSafeTranslations()

  const canAcquire = release.requestable && !release.alreadyOwned
  const narrators = release.narrators.join(', ')
  // A real byte count wins; otherwise the source's own size string; otherwise no size pill.
  const sizeText = release.sizeBytes != null ? bytesPretty(release.sizeBytes) : meaningfulText(release.sizeLabel)
  const format = meaningfulFormat(release.format)

  return (
    <div className={mergeClasses('bg-bg border-border flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between', className)} cy-id="release-card">
      <div className="min-w-0 flex-1">
        <p className="text-foreground truncate text-base font-semibold">{release.title}</p>
        <p className="text-foreground-muted truncate text-sm">
          {release.author}
          {narrators ? ` · ${narrators}` : ''}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {format != null && <DetailBadge>{format.toUpperCase()}</DetailBadge>}
          {sizeText != null && <DetailBadge>{sizeText}</DetailBadge>}
          {release.durationSeconds != null && <DetailBadge>{formatDuration(release.durationSeconds, t)}</DetailBadge>}
          <DetailBadge>{release.sourceLabel}</DetailBadge>
          {release.seeders != null && <DetailBadge>{t('LabelSeeders', { 0: release.seeders })}</DetailBadge>}
          {release.alreadyOwned && (
            <span className="bg-success/20 text-success inline-flex items-center rounded-md px-2 py-0.5 text-xs whitespace-nowrap">{t('LabelAlreadyOwned')}</span>
          )}
        </div>
      </div>
      <div className="shrink-0 self-end sm:self-auto">
        <Btn size="small" disabled={!canAcquire || submitting} loading={submitting} onClick={onAcquire}>
          {t('ButtonAcquire')}
        </Btn>
      </div>
    </div>
  )
}
