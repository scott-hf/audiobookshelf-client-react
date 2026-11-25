import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import BookCover from '../components/BookCover'
import LoadingView from '../components/LoadingView'
import Btn from '../components/ui/Btn'
import { useDownloads } from '../downloads/DownloadProvider'
import { useTypeSafeTranslations } from '../hooks/useTypeSafeTranslations'
import { libraryFilterPath } from '../lib/libraryQuery'
import type { AbsLibraryItem } from '../types/abs'

function formatDuration(seconds: number): string {
  const totalMinutes = Math.round(seconds / 60)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
}

const metaLinkClass = 'hover:text-foreground underline-offset-2 hover:underline'

/** Commas between inline links without a trailing one (a plain `join` can't hold elements). */
function Separated({ children }: { children: ReactNode[] }) {
  return (
    <>
      {children.map((child, index) => (
        <Fragment key={index}>
          {index > 0 && ', '}
          {child}
        </Fragment>
      ))}
    </>
  )
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
  // Each tappable value opens the library list narrowed to it, as the web client's item page does.
  // Authors and series filter by entity ID (a name matches nothing); genres and narrators by name.
  // When the expanded item lacks the structured list we show the plain display string un-linked
  // rather than guess at splitting it, since a name containing a comma would filter to nothing.
  const authors = metadata.authors ?? []
  const seriesRefs = metadata.series ?? []
  const narrators = metadata.narrators ?? []
  const genres = metadata.genres ?? []
  const hasDetailRows = seriesRefs.length > 0 || narrators.length > 0 || !!metadata.narratorName || genres.length > 0
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
            {authors.length > 0 ? (
              <p className="text-foreground-muted mt-1 text-sm">
                <Separated>
                  {authors.map((author) => (
                    <Link key={author.id} to={libraryFilterPath(libraryId, 'authors', author.id, author.name)} className={metaLinkClass}>
                      {author.name}
                    </Link>
                  ))}
                </Separated>
              </p>
            ) : (
              metadata.authorName && <p className="text-foreground-muted mt-1 text-sm">{metadata.authorName}</p>
            )}
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

      {hasDetailRows && (
        <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm" data-testid="book-details-metadata">
          {seriesRefs.length > 0 && (
            <>
              <dt className="text-foreground-subdued">{t('LabelSeries')}</dt>
              <dd className="text-foreground-muted">
                <Separated>
                  {seriesRefs.map((series) => (
                    <span key={series.id}>
                      <Link to={libraryFilterPath(libraryId, 'series', series.id, series.name)} className={metaLinkClass}>
                        {series.name}
                      </Link>
                      {series.sequence ? ` #${series.sequence}` : ''}
                    </span>
                  ))}
                </Separated>
              </dd>
            </>
          )}
          {(narrators.length > 0 || metadata.narratorName) && (
            <>
              <dt className="text-foreground-subdued">{t('LabelNarrators')}</dt>
              <dd className="text-foreground-muted">
                {narrators.length > 0 ? (
                  <Separated>
                    {narrators.map((narrator) => (
                      <Link key={narrator} to={libraryFilterPath(libraryId, 'narrators', narrator)} className={metaLinkClass}>
                        {narrator}
                      </Link>
                    ))}
                  </Separated>
                ) : (
                  metadata.narratorName
                )}
              </dd>
            </>
          )}
          {genres.length > 0 && (
            <>
              <dt className="text-foreground-subdued">{t('LabelGenres')}</dt>
              {/* Genre strings are shown and filtered verbatim: the server stores some multi-genre values
                  as one comma-joined string, and that exact string is the filter key. */}
              <dd className="flex flex-wrap gap-1.5">
                {genres.map((genre) => (
                  <Link
                    key={genre}
                    to={libraryFilterPath(libraryId, 'genres', genre)}
                    className="bg-primary border-border text-foreground hover:bg-bg-hover rounded-full border px-2.5 py-0.5 text-xs"
                  >
                    {genre}
                  </Link>
                ))}
              </dd>
            </>
          )}
        </dl>
      )}

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
