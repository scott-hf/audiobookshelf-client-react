import { useContext, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import ConfirmDialog from '../components/ConfirmDialog'
import DownloadRow from '../components/DownloadRow'
import Btn from '../components/ui/Btn'
import PageMessage from '../components/ui/PageMessage'
import { useDownloads } from '../downloads/DownloadProvider'
import { useTypeSafeTranslations } from '../hooks/useTypeSafeTranslations'
import { SettingsContext } from '../settings/SettingsProvider'
import { DefaultMobileSettings } from '../settings/settingsTypes'

/** Best-effort title from a persisted manifest -- falls back to the raw id if the manifest JSON
 * doesn't carry a `title` field (the native manifest shape is deliberately minimal, see
 * `DownloadItemManager.manifestJsonFor`). */
function manifestTitle(manifestJson: string, fallback: string): string {
  try {
    const parsed = JSON.parse(manifestJson) as { title?: string }
    return parsed.title ?? fallback
  } catch {
    return fallback
  }
}

export default function DownloadsPage() {
  const { queue, localItems, pause, resume, cancel, remove } = useDownloads()
  const t = useTypeSafeTranslations()
  const navigate = useNavigate()
  // Optional: the page also renders without a SettingsProvider (tests), where the default applies.
  const wifiOnly = (useContext(SettingsContext)?.settings ?? DefaultMobileSettings).wifiOnly
  const [pendingDelete, setPendingDelete] = useState<{ libraryItemId: string; title: string } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const activeQueue = queue.filter((entry) => entry.state !== 'complete' && !localItems.some((local) => local.libraryItemId === entry.libraryItemId))

  // `PlayerPage` itself starts playback on mount (see routes/PlayerPage.tsx's effect) -- it
  // resolves offline vs stream via `PlayerProvider`'s own `localItems` lookup, so this only needs
  // to land on the player route with the right itemId, matching BookDetailsPage's plain "Play"
  // navigation pattern instead of duplicating the `play()` call here.
  const handlePlayOffline = (libraryItemId: string) => {
    navigate(`/downloads/${encodeURIComponent(libraryItemId)}/play`)
  }

  const handleConfirmDelete = async () => {
    if (!pendingDelete) return
    setDeleting(true)
    setDeleteError(null)
    try {
      await remove(pendingDelete.libraryItemId)
    } catch {
      setDeleteError(t('MessageMobileDeleteDownloadFailed'))
    } finally {
      setDeleting(false)
      setPendingDelete(null)
    }
  }

  return (
    <div>
      <h1 className="text-foreground text-lg font-semibold">{t('HeaderMobileDownloads')}</h1>
      <p className="text-foreground-subdued mt-1 mb-4 flex items-center gap-1 text-xs" data-testid="downloads-storage-policy">
        <span className="material-symbols text-sm" aria-hidden="true">
          wifi
        </span>
        {wifiOnly ? t('MessageMobileDownloadsWifiOnly') : t('MessageMobileDownloadsAnyNetwork')}
      </p>

      <section className="mb-6">
        <h2 className="text-foreground-muted mb-2 text-xs font-semibold tracking-widest uppercase">{t('HeaderMobileDownloadsInProgress')}</h2>
        {activeQueue.length === 0 ? (
          <p className="text-foreground-subdued text-sm">{t('MessageMobileNothingDownloading')}</p>
        ) : (
          <div className="flex flex-col gap-2" data-testid="downloads-queue">
            {activeQueue.map((entry) => (
              <DownloadRow key={entry.id} download={entry} onPause={(id) => void pause(id)} onResume={(id) => void resume(id)} onCancel={(id) => void cancel(id)} />
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-foreground-muted mb-2 text-xs font-semibold tracking-widest uppercase">{t('HeaderMobileOfflineLibrary')}</h2>
        {deleteError && (
          <p className="text-error mb-2 text-xs" role="alert" data-testid="downloads-delete-error">
            {deleteError}
          </p>
        )}
        {localItems.length === 0 ? (
          <PageMessage message={t('MessageMobileNothingDownloaded')} description={t('MessageMobileNothingDownloadedDescription')} />
        ) : (
          <div className="flex flex-col gap-2" data-testid="downloads-local-items">
            {localItems.map((item) => {
              const title = manifestTitle(item.manifestJson, item.libraryItemId)
              return (
                <div key={item.libraryItemId} className="bg-primary border-border flex items-center gap-3 rounded-md border p-3" data-testid="download-local-row">
                  <span className="material-symbols text-accent text-xl" aria-hidden="true">
                    download_done
                  </span>
                  <p className="text-foreground min-w-0 flex-1 truncate text-sm font-semibold">{title}</p>
                  <Btn size="small" color="bg-accent" onClick={() => handlePlayOffline(item.libraryItemId)} className="justify-center">
                    {t('ButtonMobilePlayOffline')}
                  </Btn>
                  <Btn
                    size="small"
                    color="bg-error"
                    ariaLabel={`${t('ButtonDelete')} ${title}`}
                    onClick={() => setPendingDelete({ libraryItemId: item.libraryItemId, title })}
                    className="justify-center"
                  >
                    {t('ButtonDelete')}
                  </Btn>
                </div>
              )
            })}
          </div>
        )}
      </section>

      <ConfirmDialog
        isOpen={!!pendingDelete}
        message={pendingDelete ? t('MessageMobileConfirmDeleteDownload', { title: pendingDelete.title }) : ''}
        confirmLabel={t('ButtonDelete')}
        confirmColor="bg-error"
        processing={deleting}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => void handleConfirmDelete()}
      />
    </div>
  )
}
