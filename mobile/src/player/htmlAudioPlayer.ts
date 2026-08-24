import type { AbsClient } from '../api/absClient'
import { AudioLike, INITIAL_PLAYER_STATE, PlayerState } from './playerTypes'

const SYNC_INTERVAL_MS = 15_000
const DEVICE_ID = 'shelfdroid-android'

export type PlayerListener = (state: PlayerState) => void

export interface HtmlAudioPlayerDeps {
  api: AbsClient
  /** Defaults to `new Audio()`; tests inject an in-memory AudioLike double. */
  createAudio?: () => AudioLike
}

/**
 * Milestone-one playback adapter: HTML5 `<audio>` streaming with periodic ABS progress sync.
 * A later native player can replace this class without changing PlayerProvider's contract
 * (subscribe/play/pause/resume/seek/close).
 */
export class HtmlAudioPlayer {
  private readonly api: AbsClient
  private readonly createAudio: () => AudioLike

  private audio: AudioLike | null = null
  private sessionId: string | null = null
  private syncTimer: ReturnType<typeof setInterval> | null = null
  private lastSyncedAt = 0
  private readonly listeners = new Set<PlayerListener>()
  private state: PlayerState = INITIAL_PLAYER_STATE

  constructor(deps: HtmlAudioPlayerDeps) {
    this.api = deps.api
    this.createAudio = deps.createAudio ?? (() => new Audio() as unknown as AudioLike)
  }

  subscribe(listener: PlayerListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState(): PlayerState {
    return this.state
  }

  private setState(patch: Partial<PlayerState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener(this.state)
  }

  async play(itemId: string): Promise<void> {
    await this.close()
    this.setState({ status: 'loading', itemId, currentTime: 0, duration: 0, error: null })

    try {
      const session = await this.api.startSession(itemId, {
        deviceInfo: { clientName: 'ShelfDroid', deviceId: DEVICE_ID },
        supportedMimeTypes: ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/flac', 'application/vnd.apple.mpegurl'],
        mediaPlayer: 'html5',
        forceTranscode: false,
        forceDirectPlay: false
      })
      const track = session.audioTracks[0]
      if (!track) throw new Error('Session has no audio tracks')

      const audio = this.createAudio()
      audio.src = this.api.authorizedStreamUrl(track.contentUrl)
      audio.currentTime = session.currentTime

      this.audio = audio
      this.sessionId = session.id
      this.lastSyncedAt = session.currentTime

      await audio.play()
      this.setState({ status: 'playing', duration: track.duration, currentTime: audio.currentTime })
      this.startSyncTimer()
    } catch (error) {
      this.setState({ status: 'error', error: error instanceof Error ? error.message : 'Playback failed' })
      throw error
    }
  }

  pause(): void {
    if (!this.audio) return
    this.audio.pause()
    this.stopSyncTimer()
    this.setState({ status: 'paused', currentTime: this.audio.currentTime })
    this.syncNow()
  }

  async resume(): Promise<void> {
    if (!this.audio) return
    await this.audio.play()
    this.setState({ status: 'playing' })
    this.startSyncTimer()
  }

  seek(time: number): void {
    if (!this.audio) return
    this.audio.currentTime = time
    this.setState({ currentTime: time })
  }

  private startSyncTimer(): void {
    this.stopSyncTimer()
    this.syncTimer = setInterval(() => this.syncNow(), SYNC_INTERVAL_MS)
  }

  private stopSyncTimer(): void {
    if (this.syncTimer !== null) {
      clearInterval(this.syncTimer)
      this.syncTimer = null
    }
  }

  private syncNow(): void {
    if (!this.audio || !this.sessionId) return
    const currentTime = this.audio.currentTime
    const timeListened = Math.max(0, currentTime - this.lastSyncedAt)
    this.lastSyncedAt = currentTime
    this.setState({ currentTime })
    if (timeListened > 0) {
      void this.api.syncSession(this.sessionId, { currentTime, timeListened })
    }
  }

  /** Explicit stop, item replacement, or app-background: stop syncing, report final progress,
   * and release the audio element. */
  async close(): Promise<void> {
    this.stopSyncTimer()
    const audio = this.audio
    const sessionId = this.sessionId
    this.audio = null
    this.sessionId = null

    if (audio && sessionId) {
      const currentTime = audio.currentTime
      const timeListened = Math.max(0, currentTime - this.lastSyncedAt)
      audio.pause()
      await this.api.closeSession(sessionId, { currentTime, timeListened })
    }

    this.setState({ status: 'idle', itemId: null })
  }
}
