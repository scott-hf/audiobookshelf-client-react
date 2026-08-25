import { registerPlugin } from '@capacitor/core'
import type { LocalLibraryItem } from '../downloads/downloadTypes'

/**
 * Typed contract for the Capacitor bridge to native offline-catalog/filesystem access (Storage
 * Access Framework folder picking + reading persisted `LocalLibraryItem` manifests), ported from
 * the donor Android app in WI-1496 t800 Task 2. Task 1 defines and tests only the TypeScript
 * side, following the same split as `absAudioPlayerPlugin.ts`/`absDownloaderPlugin.ts` -- the
 * native implementation is out of scope for this dispatch.
 */
export interface AbsFileSystemPlugin {
  /** Lists every fully downloaded item's local manifest, for the offline catalog UI (Task 4) to
   * render without a network round trip. WI-1496 t800 Task 4 reconciliation: `AbsFileSystem.kt`'s
   * `listLocalItems()` actually resolves `{ items: [...] }`, not a bare top-level array -- same
   * "Capacitor can't marshal a bare array" constraint as `AbsDownloaderPlugin.listQueue()`. */
  listLocalItems(): Promise<{ items: LocalLibraryItem[] }>
  /** Opens the OS's SAF folder picker so the user can choose where downloads are stored; returns
   * the persisted tree URI (already granted `takePersistableUriPermission` on the native side). */
  chooseDownloadFolder(): Promise<{ folderUri: string } | null>
  /** Deletes a `LocalLibraryItem`'s on-disk files (backing `AbsDownloaderPlugin.remove`, called
   * separately since removing local files is a filesystem concern, not a download-queue one). */
  deleteLocalItem(options: { libraryItemId: string }): Promise<void>
}

/** Native bridge to android/app/.../plugins/AbsFileSystem.kt (Task 2). No web implementation is
 * registered -- matches `absAudioPlayerPlugin.ts`/`absDownloaderPlugin.ts`'s pattern. Consumers
 * only construct an adapter around this when `Capacitor.isNativePlatform()` is true. */
const AbsFileSystemNative = registerPlugin<AbsFileSystemPlugin>('AbsFileSystem')

export default AbsFileSystemNative
