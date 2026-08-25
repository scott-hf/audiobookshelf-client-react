import DownloadRow from '../components/DownloadRow'
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
  const activeQueue = queue.filter((entry) => entry.state !== 'complete' && !localItems.some((local) => local.libraryItemId === entry.libraryItemId))

  return (
    <div className="downloads-page">
      <h1>Downloads</h1>
      <p className="downloads-page-policy" data-testid="downloads-storage-policy">
        Downloads use Wi-Fi only
      </p>

      <section>
        <h2>In progress</h2>
        {activeQueue.length === 0 ? (
          <p>Nothing downloading right now.</p>
        ) : (
          <div className="downloads-queue-list" data-testid="downloads-queue">
            {activeQueue.map((entry) => (
              <DownloadRow key={entry.id} download={entry} onPause={(id) => void pause(id)} onResume={(id) => void resume(id)} onCancel={(id) => void cancel(id)} />
            ))}
          </div>
        )}
      </section>

      <section>
        <h2>Offline library</h2>
        {localItems.length === 0 ? (
          <p>Nothing downloaded yet.</p>
        ) : (
          <div className="downloads-local-list" data-testid="downloads-local-items">
            {localItems.map((item) => (
              <div key={item.libraryItemId} className="download-local-row" data-testid="download-local-row">
                <p className="download-local-title">{manifestTitle(item.manifestJson, item.libraryItemId)}</p>
                {/* Local track selection/playback is Task 5 -- this button is a real, enabled
                    control (the offline catalog's whole point) but only wires up actual audio
                    once offlineSource.ts exists. */}
                <button type="button" className="download-row-button">
                  Play offline
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
