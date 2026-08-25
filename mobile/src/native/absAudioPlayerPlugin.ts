import { registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import type { AbsPlaybackSession } from '../types/abs'
import type { NativePlayerState, PlayerSnapshot } from '../player/playerTypes'

/** Options passed to the native plugin's `load` call: the resolved ABS playback session plus
 * the auth material the native ExoPlayer HTTP data source needs (it makes its own requests,
 * outside the JS `AbsClient`). */
export interface AbsAudioPlayerLoadOptions {
  session: AbsPlaybackSession
  accessToken: string
  serverUrl: string
}

/**
 * Typed contract for the Capacitor bridge to the native (Kotlin/ExoPlayer) audio player,
 * ported from the donor Android app in WI-1496 t700 Task 2. Task 1 defines and tests only the
 * TypeScript side of this contract; the native implementation (`AbsAudioPlayer.kt`) is out of
 * scope for this dispatch.
 */
export interface AbsAudioPlayerPlugin {
  load(options: AbsAudioPlayerLoadOptions): Promise<void>
  play(): Promise<void>
  pause(): Promise<void>
  seek(options: { seconds: number }): Promise<void>
  setRate(options: { rate: number }): Promise<void>
  stop(): Promise<void>
  setSleepTimer(options: { seconds: number | null }): Promise<void>
  getState(): Promise<PlayerSnapshot>
  addListener(event: 'playerState', listener: (state: NativePlayerState) => void): Promise<PluginListenerHandle>
}

/** Native bridge to android/app/.../plugins/AbsAudioPlayer.kt. No web implementation is
 * registered -- there is no native player outside the Android app, matching
 * native/secureSession.ts's pattern for SecureSessionPlugin. `PlayerProvider` only constructs
 * an adapter around this when `Capacitor.isNativePlatform()` is true, so web/dev-preview never
 * calls it. */
const AbsAudioPlayerNative = registerPlugin<AbsAudioPlayerPlugin>('AbsAudioPlayer')

export default AbsAudioPlayerNative
