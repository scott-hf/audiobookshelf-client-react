export type PlayerStatus = 'idle' | 'loading' | 'buffering' | 'playing' | 'paused' | 'ended' | 'error'

export interface PlayerState {
  status: PlayerStatus
  itemId: string | null
  currentTime: number
  duration: number
  error: string | null
}

export const INITIAL_PLAYER_STATE: PlayerState = {
  status: 'idle',
  itemId: null,
  currentTime: 0,
  duration: 0,
  error: null
}

/**
 * Extension of `PlayerState` for playback backends that additionally report a live rate
 * (native ExoPlayer does; the milestone-one HTML5 player does not track it separately).
 * Extends rather than replaces `PlayerState` -- existing `HtmlAudioPlayer`/`PlayerProvider`
 * consumers of `PlayerState` are unaffected by this addition.
 */
export interface PlayerSnapshot extends PlayerState {
  rate: number
}

export const INITIAL_PLAYER_SNAPSHOT: PlayerSnapshot = {
  ...INITIAL_PLAYER_STATE,
  rate: 1
}

/** Raw state payload emitted by the native `AbsAudioPlayerPlugin` `playerState` event. */
export type NativePlayerStatus = 'buffering' | 'playing' | 'paused' | 'ended' | 'error'

export interface NativePlayerState {
  state: NativePlayerStatus
  currentTime: number
  duration: number
  playbackRate: number
  error?: string
}

/** Minimal HTMLMediaElement surface the player depends on -- lets tests inject a fake
 * in-memory implementation instead of relying on jsdom's unimplemented audio playback. */
export interface AudioLike {
  src: string
  currentTime: number
  duration: number
  paused: boolean
  play(): Promise<void>
  pause(): void
}
