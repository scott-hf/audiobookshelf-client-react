import { useNavigate } from 'react-router-dom'
import DownloadRow from '../components/DownloadRow'
import Btn from '../components/ui/Btn'
import PageMessage from '../components/ui/PageMessage'
import { useDownloads } from '../downloads/DownloadProvider'

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
  const { queue, localItems, pause, resume, cancel } = useDownloads()
  const navigate = useNavigate()
  const activeQueue = queue.filter((entry) => entry.state !== 'complete' && !localItems.some((local) => local.libraryItemId === entry.libraryItemId))

  // `PlayerPage` itself starts playback on mount (see routes/PlayerPage.tsx's effect) -- it
  // resolves offline vs stream via `PlayerProvider`'s own `localItems` lookup, so this only needs
  // to land on the player route with the right itemId, matching BookDetailsPage's plain "Play"
  // navigation pattern instead of duplicating the `play()` call here.
  const handlePlayOffline = (libraryItemId: string) => {
    navigate(`/downloads/${encodeURIComponent(libraryItemId)}/play`)
  }

  return (
    <div>
      <h1 className="text-foreground text-lg font-semibold">Downloads</h1>
      <p className="text-foreground-subdued mt-1 mb-4 flex items-center gap-1 text-xs" data-testid="downloads-storage-policy">
        <span className="material-symbols text-sm" aria-hidden="true">
          wifi
        </span>
        Downloads use Wi-Fi only
      </p>

      <section className="mb-6">
        <h2 className="text-foreground-muted mb-2 text-xs font-semibold tracking-widest uppercase">In progress</h2>
        {activeQueue.length === 0 ? (
          <p className="text-foreground-subdued text-sm">Nothing downloading right now.</p>
        ) : (
          <div className="flex flex-col gap-2" data-testid="downloads-queue">
            {activeQueue.map((entry) => (
              <DownloadRow key={entry.id} download={entry} onPause={(id) => void pause(id)} onResume={(id) => void resume(id)} onCancel={(id) => void cancel(id)} />
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-foreground-muted mb-2 text-xs font-semibold tracking-widest uppercase">Offline library</h2>
        {localItems.length === 0 ? (
          <PageMessage message="Nothing downloaded yet." description="Downloaded books stay playable without a connection." />
        ) : (
          <div className="flex flex-col gap-2" data-testid="downloads-local-items">
            {localItems.map((item) => (
              <div key={item.libraryItemId} className="bg-primary border-border flex items-center gap-3 rounded-md border p-3" data-testid="download-local-row">
                <span className="material-symbols text-accent text-xl" aria-hidden="true">
                  download_done
                </span>
                <p className="text-foreground min-w-0 flex-1 truncate text-sm font-semibold">{manifestTitle(item.manifestJson, item.libraryItemId)}</p>
                <Btn size="small" color="bg-accent" onClick={() => handlePlayOffline(item.libraryItemId)} className="justify-center">
                  Play offline
                </Btn>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
