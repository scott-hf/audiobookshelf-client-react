import type { AbsAudioPlayerLoadOptions, AbsAudioPlayerPlugin } from '../native/absAudioPlayerPlugin'
import { INITIAL_PLAYER_SNAPSHOT, NativePlayerState, PlayerSnapshot } from './playerTypes'

export type NativeAudioPlayerListener = (state: PlayerSnapshot) => void

/**
 * Drop-in native alternative to `HtmlAudioPlayer`, backed by the Capacitor `AbsAudioPlayerPlugin`
 * bridge instead of an `<audio>` element. Exposes the same subscribe/state-snapshot shape
 * (`PlayerSnapshot`, an extension of the existing `PlayerState`) so a consumer only needs the
 * snapshot contract, not a concrete player class -- `PlayerProvider` wiring to actually select
 * this implementation is WI-1496 t700 Task 3, out of scope here.
 */
export interface NativeAudioPlayer {
  subscribe(listener: NativeAudioPlayerListener): () => void
  getState(): PlayerSnapshot
  load(options: AbsAudioPlayerLoadOptions): Promise<void>
  play(): Promise<void>
  pause(): Promise<void>
  seek(seconds: number): Promise<void>
  setRate(rate: number): Promise<void>
  stop(): Promise<void>
  setSleepTimer(seconds: number | null): Promise<void>
}

/** Maps a raw native `playerState` event payload into a `PlayerSnapshot` patch, clamping
 * position into `0..duration` and surfacing a default error message when the native side
 * reports `error` without one. */
function mapNativeState(native: NativePlayerState): Partial<PlayerSnapshot> {
  const duration = Math.max(0, native.duration)
  const currentTime = Math.min(Math.max(0, native.currentTime), duration)
  return {
    status: native.state,
    currentTime,
    duration,
    rate: native.playbackRate,
    error: native.state === 'error' ? (native.error ?? 'Native playback failed') : null
  }
}

export function createNativeAudioPlayer(plugin: AbsAudioPlayerPlugin): NativeAudioPlayer {
  const listeners = new Set<NativeAudioPlayerListener>()
  let state: PlayerSnapshot = INITIAL_PLAYER_SNAPSHOT

  const setState = (patch: Partial<PlayerSnapshot>): void => {
    state = { ...state, ...patch }
    for (const listener of listeners) listener(state)
  }

  void plugin.addListener('playerState', (native) => setState(mapNativeState(native)))

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getState() {
      return state
    },
    async load(options) {
      setState({ status: 'loading', itemId: options.session.id, currentTime: 0, duration: 0, error: null })
      await plugin.load(options)
    },
    async play() {
      await plugin.play()
    },
    async pause() {
      await plugin.pause()
    },
    async seek(seconds) {
      await plugin.seek({ seconds })
    },
    async setRate(rate) {
      await plugin.setRate({ rate })
    },
    async stop() {
      await plugin.stop()
      setState({ status: 'idle', itemId: null })
    },
    async setSleepTimer(seconds) {
      await plugin.setSleepTimer({ seconds })
    }
  }
}
