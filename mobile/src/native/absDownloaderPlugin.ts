import { registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import type { AbsChapter, AbsPlaybackSession } from '../types/abs'
import type { RawDownloadEvent } from '../downloads/downloadTypes'

/** Options passed to the native plugin's `enqueue` call: the resolved ABS playback session
 * (audio tracks + urls, same shape `AbsAudioPlayerPlugin.load` already consumes in t700) plus
 * the auth/display material the native downloader needs to make its own HTTP requests and show
 * a meaningful queue entry, independent of the JS `AbsClient`. */
export interface AbsDownloaderEnqueueOptions {
  libraryItemId: string
  title: string
  session: AbsPlaybackSession
  accessToken: string
  serverUrl: string
  serverConnectionId: string
  /** Wi-Fi-only preference for this transfer (`AbsDownloader.kt` `enqueue`). Optional: omitted, the
   * native side keeps the policy last set by `setWifiOnly`. */
  wifiOnly?: boolean
  /** Server-relative cover URL (`/api/items/{id}/cover`). The native side downloads it next to the
   * audio once the audio is complete; a failure never fails the book. Optional/additive. */
  coverPath?: string
  /** Best-effort presentation metadata stored in the offline manifest. Optional/additive. */
  metadata?: {
    author?: string
    narrator?: string
    /** Total duration, seconds. */
    duration?: number
    chapters?: AbsChapter[]
  }
}

/**
 * Typed contract for the Capacitor bridge to the native (Kotlin/WorkManager-equivalent) offline
 * downloader, ported from the donor Android app in WI-1496 t800 Task 2. Task 1 defines and tests
 * only the TypeScript side of this contract, following the same split t700's
 * `absAudioPlayerPlugin.ts` used -- the native implementation is out of scope for this dispatch.
 */
export interface AbsDownloaderPlugin {
  enqueue(options: AbsDownloaderEnqueueOptions): Promise<{ id: string }>
  pause(options: { id: string }): Promise<void>
  resume(options: { id: string }): Promise<void>
  cancel(options: { id: string }): Promise<void>
  /** Removes a completed download's local files (distinct from `cancel`, which only stops an
   * in-flight one) -- the offline catalog's "delete downloaded book" action. */
  remove(options: { libraryItemId: string }): Promise<void>
  /** WI-1496 t800 Task 4 reconciliation: `AbsDownloader.kt`'s `listQueue()` actually resolves
   * `{ items: [...] }` (`JSObject().put("items", array)`), not a bare top-level array -- Capacitor
   * plugin calls can't marshal a bare array through `PluginCall.resolve`. Each item is
   * `RawDownloadEvent`-shaped (no `progressPercent`, computed client-side by `toDownloadSnapshot`),
   * not the already-derived `DownloadSnapshot` this Task 1 sketch originally declared. */
  listQueue(): Promise<{ items: RawDownloadEvent[] }>
  /** Pushes the Wi-Fi-only preference to the native transfer policy (`AbsDownloader.kt`
   * `setWifiOnly` -> `DownloadServiceHost.setWifiOnly`). `DownloadProvider` calls it on mount and
   * whenever the setting changes, so a toggle reaches native while downloads are parked. */
  setWifiOnly(options: { wifiOnly: boolean }): Promise<void>
  addListener(event: 'downloadProgress', listener: (state: RawDownloadEvent) => void): Promise<PluginListenerHandle>
  addListener(event: 'downloadComplete', listener: (state: RawDownloadEvent) => void): Promise<PluginListenerHandle>
  addListener(event: 'downloadFailed', listener: (state: RawDownloadEvent) => void): Promise<PluginListenerHandle>
}

/** Native bridge to android/app/.../plugins/AbsDownloader.kt (Task 2). No web implementation is
 * registered -- matches `absAudioPlayerPlugin.ts` and `native/secureSession.ts`'s pattern.
 * Consumers only construct an adapter around this when `Capacitor.isNativePlatform()` is true. */
const AbsDownloaderNative = registerPlugin<AbsDownloaderPlugin>('AbsDownloader')

export default AbsDownloaderNative
