import type { LocalLibraryItem } from '../downloads/downloadTypes'

/** One playable local audio track, resolved from a `LocalLibraryItem`'s persisted manifest.
 * `contentUrl` is a `file://`-scheme URI over the native downloader's final destination path
 * (see `DownloadItemManager.manifestJsonFor` on the Kotlin side) -- never a bare filesystem path,
 * since `AbsAudioPlayer.kt`'s `resolveTrackUrl` only special-cases `http(s)://`/`content://`/
 * `file://` and would otherwise mistake a bare path for a server-relative URL. */
export interface LocalTrack {
  index: number
  contentUrl: string
  duration: number
}

/** Parsed, playback-ready view of a `LocalLibraryItem`'s manifest. `complete` is true only when
 * every track the manifest lists resolved to a usable local file -- a manifest with zero tracks,
 * or with any track missing its on-disk path, is treated as partial (never eligible for offline
 * playback, per the plan's "never uses a partial item" rule). */
export interface LocalManifest {
  complete: boolean
  tracks: LocalTrack[]
}

/** Minimal shape `selectPlaybackSource` needs from the library item being played -- avoids a
 * hard dependency on the full `AbsLibraryItem` type so callers that only have an id (e.g. the
 * offline catalog, which has no live `AbsLibraryItem` for its entries) can still call it. */
export interface PlayableItem {
  id: string
}

export type PlaybackSource = { kind: 'offline'; tracks: LocalTrack[] } | { kind: 'stream'; itemId: string }

/** Converts a native downloader's absolute filesystem path (or an already-scheme-qualified
 * `content://`/`file://` URI) into a URI `AbsAudioPlayer.kt`'s `resolveTrackUrl` will pass
 * through untouched instead of treating as a server-relative path. */
function toLocalUri(path: string): string {
  if (path.startsWith('content://') || path.startsWith('file://')) return path
  return `file://${path}`
}

interface RawManifestTrack {
  trackIndex?: number
  path?: string
}

interface RawManifest {
  tracks?: RawManifestTrack[]
}

/** Parses a `LocalLibraryItem.manifestJson` (written by `DownloadItemManager.manifestJsonFor`)
 * into a `LocalManifest`. Returns `null` when there is no local record at all, distinct from a
 * present-but-partial manifest (`complete: false`) -- callers use `null` to mean "not downloaded"
 * and `complete: false` to mean "downloaded but not safely playable offline". */
export function parseLocalManifest(local: LocalLibraryItem | null | undefined): LocalManifest | null {
  if (!local) return null

  let parsed: RawManifest
  try {
    parsed = JSON.parse(local.manifestJson) as RawManifest
  } catch {
    return { complete: false, tracks: [] }
  }

  const rawTracks = parsed.tracks ?? []
  const tracks: LocalTrack[] = rawTracks
    .filter((track): track is Required<RawManifestTrack> => typeof track.path === 'string' && track.path.length > 0 && typeof track.trackIndex === 'number')
    .map((track) => ({ index: track.trackIndex, contentUrl: toLocalUri(track.path), duration: 0 }))
    .sort((a, b) => a.index - b.index)

  return { complete: tracks.length > 0 && tracks.length === rawTracks.length, tracks }
}

/** Chooses between offline playback (a complete local manifest) and the normal ABS stream path.
 * Never falls back to a partial local manifest -- a partially-downloaded item still streams,
 * matching the plan's Step 3 contract. */
export function selectPlaybackSource(item: PlayableItem, local: LocalManifest | null): PlaybackSource {
  if (local?.complete && local.tracks.length > 0) return { kind: 'offline', tracks: local.tracks }
  return { kind: 'stream', itemId: item.id }
}
