export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'error'

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
