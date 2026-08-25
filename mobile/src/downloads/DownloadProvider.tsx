import { Capacitor } from '@capacitor/core'
import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthProvider'
import AbsDownloaderNative from '../native/absDownloaderPlugin'
import AbsFileSystemNative from '../native/absFileSystemPlugin'
import type { AbsLibraryItem } from '../types/abs'
import { DownloadSnapshot, LocalLibraryItem, RawDownloadEvent, toDownloadSnapshot } from './downloadTypes'

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

/**
 * React-side offline download queue/catalog (WI-1496 t800 Task 4), mirroring
 * `AcquisitionProvider`'s "context owns the live state, pages just read it" shape. Native-only:
 * on the web/dev-preview path (`Capacitor.isNativePlatform()` false) every action is a no-op and
 * the queue/local-item lists stay empty, matching `PlayerProvider`'s own native-vs-web split.
 */
export function DownloadProvider({ children }: { children: ReactNode }) {
  const { client } = useAuth()
  const isNative = Capacitor.isNativePlatform()
  const [queue, setQueue] = useState<DownloadSnapshot[]>([])
  const [localItems, setLocalItems] = useState<LocalLibraryItem[]>([])

  const applyEvent = useCallback((raw: RawDownloadEvent) => {
    const snapshot = toDownloadSnapshot(raw)
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
  }, [isNative])

  useEffect(() => {
    if (!isNative) return
    let cancelled = false
    AbsDownloaderNative.listQueue().then((response) => {
      if (!cancelled) setQueue(response.items.map(toDownloadSnapshot))
    })
    void refreshLocalItems()

    const progressHandle = AbsDownloaderNative.addListener('downloadProgress', applyEvent)
    const completeHandle = AbsDownloaderNative.addListener('downloadComplete', (raw) => {
      applyEvent(raw)
      void refreshLocalItems()
    })
    const failedHandle = AbsDownloaderNative.addListener('downloadFailed', applyEvent)

    return () => {
      cancelled = true
      void progressHandle.then((handle) => handle.remove())
      void completeHandle.then((handle) => handle.remove())
      void failedHandle.then((handle) => handle.remove())
    }
  }, [isNative, applyEvent, refreshLocalItems])

  const isLocal = useCallback((libraryItemId: string) => localItems.some((item) => item.libraryItemId === libraryItemId), [localItems])

  /** Skips re-queueing a book already queued unless its last attempt failed, per the plan's
   * Step 3 dedupe rule. */
  const download = useCallback(
    async (item: AbsLibraryItem) => {
      if (!isNative) return
      const existing = queue.find((entry) => entry.libraryItemId === item.id)
      if (existing && existing.state !== 'failed') return

      const session = await client.startSession(item.id, {
        deviceInfo: { clientName: 'ShelfDroid', deviceId: DEVICE_ID },
        supportedMimeTypes: ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/flac', 'application/vnd.apple.mpegurl'],
        mediaPlayer: 'exo',
        forceTranscode: false,
        forceDirectPlay: false
      })
      const accessToken = client.getAccessToken()
      const serverUrl = client.getServerUrl()
      if (!accessToken || !serverUrl) throw new Error('Not authenticated')

      await AbsDownloaderNative.enqueue({
        libraryItemId: item.id,
        title: item.media.metadata.title,
        session,
        accessToken,
        serverUrl,
        // This milestone has no multi-account concept -- the server URL itself is a stable
        // per-connection identity, matching how the native side scopes internal storage
        // (`downloads/{serverConnectionId}/{libraryItemId}`, see `FolderScanner.finalInternalPath`).
        serverConnectionId: serverUrl
      })
    },
    [isNative, queue, client]
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
