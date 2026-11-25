import { Capacitor } from '@capacitor/core'
import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { AbsClient } from '../api/absClient'
import { buildProgressMap, getProgress } from '../api/progressMap'
import { useAuth } from '../auth/AuthProvider'
import AbsDownloaderNative from '../native/absDownloaderPlugin'
import AbsFileSystemNative from '../native/absFileSystemPlugin'
import { cacheServerProgress, localOfflineProgressStorage } from '../player/offlineProgress'
import { SettingsContext } from '../settings/SettingsProvider'
import { DefaultMobileSettings, localSettingsStorage } from '../settings/settingsTypes'
import type { AbsLibraryItem, AbsPlaybackSession } from '../types/abs'
import { DownloadSnapshot, LocalLibraryItem, RawDownloadEvent, toDownloadSnapshot, withoutOrphanedComplete } from './downloadTypes'

export interface DownloadContextValue {
  queue: DownloadSnapshot[]
  localItems: LocalLibraryItem[]
  isLocal: (libraryItemId: string) => boolean
  download: (item: AbsLibraryItem) => Promise<void>
  pause: (id: string) => Promise<void>
  resume: (id: string) => Promise<void>
  cancel: (id: string) => Promise<void>
  remove: (libraryItemId: string) => Promise<void>
}

export const DownloadContext = createContext<DownloadContextValue | undefined>(undefined)

const DEVICE_ID = 'shelfdroid-android'

/** Direct-file formats only. A download saves exactly the bytes the server sends for each track
 * URL, so an HLS/transcode playlist (`application/vnd.apple.mpegurl`) must never be accepted --
 * it would be stored as a `.m3u8` text file instead of audio. */
const DOWNLOAD_MIME_TYPES = ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/flac', 'audio/ogg', 'audio/opus']

/** True when the session hands back streaming-playlist URLs rather than direct audio files. */
function isStreamingSession(session: AbsPlaybackSession): boolean {
  return session.audioTracks.some((track) => /\/hls\/|\.m3u8(\?|$)/i.test(track.contentUrl))
}

/** Best-effort: `download()` only opens a play session to learn the track URLs, so it must close
 * it again (or the server keeps counting it as an open listening session). Never throws.
 *
 * Closes with NO body on purpose. Nothing was played here, so there is no progress to report, and
 * reporting one is actively destructive: ABS opens a session for an already-finished item at
 * currentTime 0, so closing with `session.currentTime` wrote 0 back and cleared `isFinished`.
 * Downloading a finished book wiped it -- four books on 2026-11-24. */
async function closeSessionQuietly(client: AbsClient, session: AbsPlaybackSession): Promise<void> {
  try {
    await client.closeSession(session.id)
  } catch {
    // The session expires server-side on its own; nothing useful to do with a failure here.
  }
}

/**
 * React-side offline download queue/catalog (WI-1496 t800 Task 4), mirroring
 * `AcquisitionProvider`'s "context owns the live state, pages just read it" shape. Native-only:
 * on the web/dev-preview path (`Capacitor.isNativePlatform()` false) every action is a no-op and
 * the queue/local-item lists stay empty, matching `PlayerProvider`'s own native-vs-web split.
 */
export function DownloadProvider({ children }: { children: ReactNode }) {
  const { client } = useAuth()
  // Read through a ref by the long-lived download-complete listener so the listener effect does not
  // re-subscribe whenever the client identity changes.
  const clientRef = useRef(client)
  clientRef.current = client
  const isNative = Capacitor.isNativePlatform()
  const [queue, setQueue] = useState<DownloadSnapshot[]>([])
  const [localItems, setLocalItems] = useState<LocalLibraryItem[]>([])
  const settingsContext = useContext(SettingsContext)
  const contextWifiOnly = settingsContext?.settings.wifiOnly

  /** The current Wi-Fi-only preference: the live settings context when this provider sits under
   * one, else the persisted settings (`SettingsProvider` writes every change to
   * `localSettingsStorage`, so reading it back always yields the latest choice). */
  const resolveWifiOnly = useCallback(async (): Promise<boolean> => {
    if (contextWifiOnly !== undefined) return contextWifiOnly
    const stored = await localSettingsStorage.read()
    return stored?.wifiOnly ?? DefaultMobileSettings.wifiOnly
  }, [contextWifiOnly])

  const pushWifiOnly = useCallback(async () => {
    try {
      await AbsDownloaderNative.setWifiOnly({ wifiOnly: await resolveWifiOnly() })
    } catch {
      // Best effort: the native side keeps its last known (or conservative default) policy. Also
      // swallows a plugin without the method (older native build, test mocks).
    }
  }, [resolveWifiOnly])

  const applyEvent = useCallback((raw: RawDownloadEvent) => {
    const snapshot = toDownloadSnapshot(raw)
    // A cancelled download is gone natively; keeping its row would also block a re-download.
    if (snapshot.state === 'cancelled') {
      setQueue((prev) => prev.filter((entry) => entry.id !== snapshot.id))
      return
    }
    setQueue((prev) => {
      const index = prev.findIndex((entry) => entry.id === snapshot.id)
      if (index === -1) return [snapshot, ...prev]
      return prev.map((entry, i) => (i === index ? snapshot : entry))
    })
  }, [])

  const refreshLocalItems = useCallback(async () => {
    if (!isNative) return
    const response = await AbsFileSystemNative.listLocalItems()
    setLocalItems(response.items)
    setQueue((prev) => withoutOrphanedComplete(prev, response.items))
  }, [isNative])

  /** Refreshes the cached server position for a just-finished download: a long download may have
   * outlived the position captured when it was queued. Best-effort and silent -- the queue-time
   * snapshot stays if the server cannot be reached. `cacheServerProgress` never overwrites a real
   * listening record. */
  const refreshCachedServerProgress = useCallback(async (libraryItemId: string) => {
    try {
      const me = await clientRef.current.getMe()
      const entry = getProgress(buildProgressMap(me.mediaProgress), libraryItemId)
      if (entry) cacheServerProgress(libraryItemId, entry.currentTime, { duration: entry.duration })
    } catch {
      // Offline or a partial client: keep whatever was cached at queue time.
    }
  }, [])

  useEffect(() => {
    if (!isNative) return
    let cancelled = false
    // Load both together so a `complete` queue row whose files are gone (hidden from the local
    // list by the native integrity check) is dropped instead of blocking a re-download.
    void Promise.all([AbsDownloaderNative.listQueue(), AbsFileSystemNative.listLocalItems()])
      .then(([queueResponse, localResponse]) => {
        if (cancelled) return
        setLocalItems(localResponse.items)
        setQueue(withoutOrphanedComplete(queueResponse.items.map(toDownloadSnapshot), localResponse.items))
      })
      .catch(() => undefined)

    const progressHandle = AbsDownloaderNative.addListener('downloadProgress', applyEvent)
    const completeHandle = AbsDownloaderNative.addListener('downloadComplete', (raw) => {
      applyEvent(raw)
      void refreshLocalItems()
      if (raw.libraryItemId) void refreshCachedServerProgress(raw.libraryItemId)
    })
    const failedHandle = AbsDownloaderNative.addListener('downloadFailed', applyEvent)

    return () => {
      cancelled = true
      void progressHandle.then((handle) => handle.remove())
      void completeHandle.then((handle) => handle.remove())
      void failedHandle.then((handle) => handle.remove())
    }
  }, [isNative, applyEvent, refreshLocalItems, refreshCachedServerProgress])

  // Tell the native transfer policy the Wi-Fi-only preference on mount and whenever it changes.
  useEffect(() => {
    if (isNative) void pushWifiOnly()
  }, [isNative, pushWifiOnly])

  const isLocal = useCallback((libraryItemId: string) => localItems.some((item) => item.libraryItemId === libraryItemId), [localItems])

  /** Skips re-queueing a book that is already queued or downloaded, per the plan's Step 3
   * dedupe rule. A failed or cancelled attempt -- or a `complete` row whose files are gone from
   * the offline library -- may be started again. */
  const download = useCallback(
    async (item: AbsLibraryItem) => {
      if (!isNative) return
      const existing = queue.find((entry) => entry.libraryItemId === item.id)
      if (existing) {
        const retryable =
          existing.state === 'failed' || existing.state === 'cancelled' || (existing.state === 'complete' && !localItems.some((local) => local.libraryItemId === item.id))
        if (!retryable) return
      }

      const session = await client.startSession(item.id, {
        deviceInfo: { clientName: 'ShelfDroid', deviceId: DEVICE_ID },
        supportedMimeTypes: DOWNLOAD_MIME_TYPES,
        mediaPlayer: 'exo',
        forceTranscode: false,
        forceDirectPlay: true
      })
      try {
        if (isStreamingSession(session)) throw new Error('This book can only be streamed, not downloaded')
        const accessToken = client.getAccessToken()
        const serverUrl = client.getServerUrl()
        if (!accessToken || !serverUrl) throw new Error('Not authenticated')

        await pushWifiOnly()
        // List results carry no chapters; the expanded item does. Metadata is best-effort, so a
        // failed lookup just downloads what we already have.
        let detailed = item
        if (!item.media.chapters) {
          try {
            detailed = (await client.getLibraryItem(item.id)) ?? item
          } catch {
            detailed = item
          }
        }
        await AbsDownloaderNative.enqueue({
          libraryItemId: item.id,
          title: item.media.metadata.title,
          session,
          accessToken,
          serverUrl,
          // This milestone has no multi-account concept -- the server URL itself is a stable
          // per-connection identity, matching how the native side scopes internal storage
          // (`downloads/{serverConnectionId}/{libraryItemId}`, see `FolderScanner.finalInternalPath`).
          serverConnectionId: serverUrl,
          coverPath: `/api/items/${encodeURIComponent(item.id)}/cover`,
          metadata: {
            author: detailed.media.metadata.authorName ?? undefined,
            narrator: detailed.media.metadata.narratorName ?? undefined,
            duration: detailed.media.duration ?? undefined,
            chapters: detailed.media.chapters ?? undefined
          }
        })
        // We are online (this session was just opened), so remember where the server has this book:
        // an offline first play has no session to ask and would otherwise start at 0:00. Refreshed
        // again on completion; never overwrites a position this device actually listened to.
        //
        // Read the position from `/api/me` -> mediaProgress, NOT from `session.currentTime`: a
        // session opened on a finished item reports 0, which would have cached 0:00 as "where the
        // server has this book" and restarted a finished book from the beginning offline.
        await refreshCachedServerProgress(item.id)
      } finally {
        await closeSessionQuietly(client, session)
      }
    },
    [isNative, queue, localItems, client, pushWifiOnly, refreshCachedServerProgress]
  )

  const pause = useCallback(
    async (id: string) => {
      if (isNative) await AbsDownloaderNative.pause({ id })
    },
    [isNative]
  )
  const resume = useCallback(
    async (id: string) => {
      if (isNative) await AbsDownloaderNative.resume({ id })
    },
    [isNative]
  )
  const cancel = useCallback(
    async (id: string) => {
      if (isNative) await AbsDownloaderNative.cancel({ id })
    },
    [isNative]
  )
  const remove = useCallback(
    async (libraryItemId: string) => {
      if (!isNative) return
      await AbsDownloaderNative.remove({ libraryItemId })
      // The native side drops its queue row too; mirror that so a stale `complete` entry cannot
      // block downloading the book again.
      setQueue((prev) => prev.filter((entry) => entry.libraryItemId !== libraryItemId && entry.id !== libraryItemId))
      // Drop the locally-cached resume position with the files -- both a recorded listening
      // position and a cached server snapshot (they share one record). Leaving either behind would
      // resume a re-downloaded book at a position the user never reached in that copy; the ABS
      // server remains the durable record of progress, and this store is only an offline cache of it.
      localOfflineProgressStorage.clear(libraryItemId)
      await refreshLocalItems()
    },
    [isNative, refreshLocalItems]
  )

  return <DownloadContext.Provider value={{ queue, localItems, isLocal, download, pause, resume, cancel, remove }}>{children}</DownloadContext.Provider>
}

export function useDownloads(): DownloadContextValue {
  const value = useContext(DownloadContext)
  if (value === undefined) {
    throw new Error('useDownloads must be used within a DownloadProvider')
  }
  return value
}
