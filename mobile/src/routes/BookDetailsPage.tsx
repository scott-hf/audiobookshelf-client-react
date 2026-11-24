import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import BookCover from '../components/BookCover'
import LoadingView from '../components/LoadingView'
import Btn from '../components/ui/Btn'
import { useDownloads } from '../downloads/DownloadProvider'
import { useTypeSafeTranslations } from '../hooks/useTypeSafeTranslations'
import type { AbsLibraryItem } from '../types/abs'

function formatDuration(seconds: number): string {
  const totalMinutes = Math.round(seconds / 60)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
}

export default function BookDetailsPage() {
  const t = useTypeSafeTranslations()
  const { libraryId, itemId } = useParams<{ libraryId: string; itemId: string }>()
  const { client } = useAuth()
  const navigate = useNavigate()
  const { queue, isLocal, download } = useDownloads()
  const [item, setItem] = useState<AbsLibraryItem | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [downloading, setDownloading] = useState(false)

  useEffect(() => {
    if (!itemId) return
    let cancelled = false
    setItem(null)
    client
      .getLibraryItem(itemId)
      .then((result) => {
        if (!cancelled) setItem(result)
      })
      .catch(() => {
        if (!cancelled) setError(t('MessageMobileBookLoadFailed'))
      })
    return () => {
      cancelled = true
    }
  }, [client, itemId, t])

  if (!itemId || !libraryId) return null
  if (error)
    return (
      <p role="alert" className="text-error py-10 text-center">
        {error}
      </p>
    )
  if (!item) return <LoadingView label={t('MessageMobileLoadingBook')} />

  const { metadata, duration } = item.media
  const progress = item.userMediaProgress
  const queuedEntry = queue.find((entry) => entry.libraryItemId === itemId)
  const alreadyLocal = isLocal(itemId)
  const downloadDisabled = downloading || alreadyLocal || (queuedEntry !== undefined && queuedEntry.state !== 'failed')
  const coverUrl = client.authorizedStreamUrl(`/api/items/${encodeURIComponent(itemId)}/cover`)
  const progressPercent = progress ? Math.round(progress.progress * 100) : 0
  const inProgress = !!progress && !progress.isFinished && progress.currentTime > 0

  const handleDownload = async () => {
    setDownloading(true)
    try {
      await download(item)
    } catch (err) {
      console.error('Failed to queue download', err)
    } finally {
      setDownloading(false)
    }
  }

  return (
    <article>
      {/* Blurred cover backdrop, matching the upstream item page treatment */}
      <div className="relative -mx-4 -mt-3 mb-4 overflow-hidden px-4 pt-6 pb-5">
        <div className="absolute inset-0 overflow-hidden" aria-hidden="true">
          <div className="cover-bg absolute bg-cover" style={{ backgroundImage: `url(${coverUrl})` }} />
          <div className="from-background/40 to-background absolute inset-0 bg-gradient-to-b" />
        </div>

        <div className="relative flex gap-4">
          <BookCover title={metadata.title} authorName={metadata.authorName} coverUrl={coverUrl} className="w-28 shrink-0" />
          <div className="flex min-w-0 flex-1 flex-col justify-end pb-1">
            <h2 className="text-foreground text-xl leading-tight font-bold">{metadata.title}</h2>
            {metadata.authorName && <p className="text-foreground-muted mt-1 text-sm">{metadata.authorName}</p>}
            {typeof duration === 'number' && (
              <p className="text-foreground-subdued mt-2 flex items-center gap-1 text-xs">
                <span className="material-symbols text-sm" aria-hidden="true">
                  schedule
                </span>
                {formatDuration(duration)}
              </p>
            )}
          </div>
        </div>
      </div>

      {inProgress && (
        <div className="mb-4">
          <div className="text-foreground-subdued mb-1 flex justify-between text-xs">
            <span>{t('MessageMobileResumeFromMinutes', { minutes: Math.round(progress.currentTime / 60) })}</span>
            <span>{progressPercent}%</span>
          </div>
          <div className="bg-track-bg h-1.5 w-full overflow-hidden rounded-full">
            <div className="bg-accent h-full rounded-full" style={{ width: `${progressPercent}%` }} />
          </div>
        </div>
      )}

      <div className={`${alreadyLocal ? 'mb-5' : 'mb-2'} flex gap-2`}>
        <Btn
          color="bg-accent"
          className="flex-1 justify-center gap-1.5"
          onClick={() => navigate(`/library/${encodeURIComponent(libraryId)}/item/${encodeURIComponent(itemId)}/play`)}
        >
          <span className="material-symbols fill text-xl" aria-hidden="true">
            play_arrow
          </span>
          {t('ButtonPlay')}
        </Btn>
        <Btn color="bg-primary" disabled={downloadDisabled} loading={downloading} onClick={() => void handleDownload()} className="justify-center gap-1.5">
          <span className="material-symbols text-xl" aria-hidden="true">
            {alreadyLocal ? 'download_done' : 'download'}
          </span>
          {alreadyLocal ? t('LabelMobileDownloadComplete') : t('LabelMobileDownloadToDevice')}
        </Btn>
      </div>
      {/* Play streams from the server; only Download puts the book on this device for offline listening. */}
      {!alreadyLocal && (
        <p className="text-foreground-subdued mb-5 text-xs leading-snug" data-testid="book-download-hint">
          {t('MessageMobileDownloadHint')}
        </p>
      )}

      {metadata.description && <p className="text-foreground-muted text-sm leading-relaxed whitespace-pre-line">{metadata.description}</p>}
    </article>
  )
}
