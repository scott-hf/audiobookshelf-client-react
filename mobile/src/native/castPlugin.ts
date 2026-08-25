import { registerPlugin, type PluginListenerHandle } from '@capacitor/core'

/** What the native Cast bridge needs to load the ABS stream onto a receiver -- built from the
 * SAME already-authorized session `PlayerProvider` handed to the native player (see
 * `castHandoff.ts`'s doc note): this never triggers a second `AbsClient.startSession` call. */
export interface CastLoadOptions {
  contentUrl: string
  contentType: string
  title: string
  accessToken: string
  startTime: number
  rate: number
}

/** Emitted when the Cast session ends (user stopped casting, receiver disconnected, error) --
 * `currentTime` is the last position Cast reported, used to resume native playback exactly
 * where casting left off. */
export interface CastDisconnectedEvent {
  currentTime: number
}

/**
 * Typed contract for the Capacitor bridge to the native (Kotlin) Chromecast integration
 * (WI-1496 t900 Task 3), ported from the donor Android app's `CastManager`/`CastOptionsProvider`
 * session-lifecycle surface. Mirrors `absAudioPlayerPlugin.ts`'s split: this dispatch defines and
 * tests only the TypeScript side of the contract (`castHandoff.ts`); wiring a Capacitor
 * `@PluginMethod`-annotated native class to actually implement it is out of this task's file list
 * (see this task's report OPEN note) -- `CastManager.kt`/`CastOptionsProvider.kt` created this
 * task provide the session-lifecycle plumbing a future plugin class would call into.
 */
export interface CastPlugin {
  isAvailable(): Promise<{ available: boolean }>
  load(options: CastLoadOptions): Promise<void>
  addListener(event: 'disconnected', listener: (event: CastDisconnectedEvent) => void): Promise<PluginListenerHandle>
}

/** No web implementation is registered -- there is no Cast receiver outside the Android app,
 * matching `absAudioPlayerPlugin.ts`'s pattern. `PlayerProvider` only constructs a
 * `castHandoff` controller around this when `Capacitor.isNativePlatform()` is true. */
const CastNative = registerPlugin<CastPlugin>('Cast')

export default CastNative
