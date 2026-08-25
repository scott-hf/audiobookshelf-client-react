/**
 * Bridge contract for the offline-downloads milestone (WI-1496 t800 Task 1), mirroring the
 * pattern `mobile/src/player/playerTypes.ts` + `mobile/src/native/absAudioPlayerPlugin.ts`
 * established in t700: pure TS types + a `to*Snapshot` mapper here, native plugin interfaces
 * in `mobile/src/native/`. The native (Kotlin) implementation is Task 2, out of scope here.
 */

/** Lifecycle states a single queued/downloading item can be in. Mirrors Android's
 * WorkManager-style vocabulary (`waiting_for_network`/`waiting_for_space`) since the donor app's
 * download manager (ported in Task 2) is backed by WorkManager-equivalent retry semantics. */
export type DownloadState =
  | 'queued'
  | 'running'
  | 'paused'
  | 'waiting_for_network'
  | 'waiting_for_space'
  | 'complete'
  | 'failed'
  | 'cancelled'

/** Stable, JS-facing shape of one download queue entry, after `toDownloadSnapshot` has clamped
 * progress and resolved the null-vs-zero-percent distinction. */
export interface DownloadSnapshot {
  id: string
  libraryItemId: string
  title: string
  bytesDownloaded: number
  totalBytes: number
  /** `null` means "no determinate progress yet" (e.g. a `queued` item with 0/0 bytes, before the
   * native side has resolved a total size) -- distinct from `0`, which means "0% of a known
   * total downloaded so far". Never negative; clamped to 100 when bytesDownloaded > totalBytes. */
  progressPercent: number | null
  state: DownloadState
  error: string | null
}

/** Raw event/query payload shape from the native downloader plugin -- optional fields default
 * when the native side omits them (e.g. a bare progress tick that doesn't repeat title/error). */
export interface RawDownloadEvent {
  id: string
  libraryItemId?: string
  title?: string
  bytesDownloaded: number
  totalBytes: number
  state: DownloadState
  error?: string | null
}

/** Maps a raw native download event into the stable `DownloadSnapshot` contract: clamps
 * `bytesDownloaded` into `0..totalBytes` and resolves `progressPercent` (null when `totalBytes`
 * is not yet known, i.e. `<= 0`). */
export function toDownloadSnapshot(raw: RawDownloadEvent): DownloadSnapshot {
  const totalBytes = Math.max(0, raw.totalBytes)
  const clampedBytes = totalBytes > 0 ? Math.min(Math.max(0, raw.bytesDownloaded), totalBytes) : Math.max(0, raw.bytesDownloaded)
  const progressPercent = totalBytes > 0 ? Math.round((clampedBytes / totalBytes) * 100) : null

  return {
    id: raw.id,
    libraryItemId: raw.libraryItemId ?? '',
    title: raw.title ?? '',
    bytesDownloaded: clampedBytes,
    totalBytes,
    progressPercent,
    state: raw.state,
    error: raw.error ?? null
  }
}

/** Native-side record of one fully downloaded library item, persisted for offline playback and
 * for the offline catalog UI (Task 4) to list without a network round trip. */
export interface LocalLibraryItem {
  libraryItemId: string
  serverConnectionId: string
  /** SAF (Storage Access Framework) tree/document URI the downloaded audio files live under. */
  folderUri: string
  /** Serialized ABS library-item metadata (title, author, cover, tracks) captured at download
   * time -- read directly for offline browsing rather than re-fetched from the server. */
  manifestJson: string
  /** Epoch millis the download finished. */
  completedAt: number
}
