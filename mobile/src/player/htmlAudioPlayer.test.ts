import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AbsClient } from '../api/absClient'
import { HtmlAudioPlayer } from './htmlAudioPlayer'
import type { AudioLike } from './playerTypes'

class FakeAudio implements AudioLike {
  src = ''
  currentTime = 0
  duration = 0
  paused = true
  private ticker: ReturnType<typeof setInterval> | null = null

  play(): Promise<void> {
    this.paused = false
    this.ticker = setInterval(() => {
      this.currentTime += 1
    }, 1000)
    return Promise.resolve()
  }

  pause(): void {
    this.paused = true
    if (this.ticker !== null) {
      clearInterval(this.ticker)
      this.ticker = null
    }
  }
}

function session(overrides: { id: string; currentTime?: number; audioTracks: Array<{ contentUrl: string; duration: number; index?: number }> }) {
  return {
    id: overrides.id,
    currentTime: overrides.currentTime ?? 0,
    audioTracks: overrides.audioTracks.map((track, index) => ({ index: track.index ?? index, contentUrl: track.contentUrl, duration: track.duration }))
  }
}

function fakeApi(): AbsClient {
  return {
    getLibraries: vi.fn(),
    getLibraryItems: vi.fn(),
    getLibraryItem: vi.fn(),
    startSession: vi.fn(),
    syncSession: vi.fn().mockResolvedValue(undefined),
    closeSession: vi.fn().mockResolvedValue(undefined),
    authorizedStreamUrl: vi.fn((contentUrl: string) => `https://books.test${contentUrl}?token=t`)
  } as unknown as AbsClient
}

describe('HtmlAudioPlayer', () => {
  let api: AbsClient
  let audio: FakeAudio

  beforeEach(() => {
    vi.useFakeTimers()
    api = fakeApi()
    audio = new FakeAudio()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts, syncs every 15 seconds, and closes with final progress', async () => {
    ;(api.startSession as ReturnType<typeof vi.fn>).mockResolvedValue(
      session({ id: 's1', audioTracks: [{ contentUrl: '/api/items/b1/file/f1', duration: 3600 }] })
    )

    const player = new HtmlAudioPlayer({ api, createAudio: () => audio })
    await player.play('b1')
    expect(player.getState().status).toBe('playing')

    await vi.advanceTimersByTimeAsync(15_000)

    expect(api.syncSession).toHaveBeenCalledWith('s1', expect.objectContaining({ currentTime: 15 }))

    await player.close()
    expect(api.closeSession).toHaveBeenCalledWith('s1', expect.any(Object))
    expect(player.getState().status).toBe('idle')
  })

  it('sets duration and streams from the authorized track URL', async () => {
    ;(api.startSession as ReturnType<typeof vi.fn>).mockResolvedValue(
      session({ id: 's1', currentTime: 42, audioTracks: [{ contentUrl: '/api/items/b1/file/f1', duration: 3600 }] })
    )

    const player = new HtmlAudioPlayer({ api, createAudio: () => audio })
    await player.play('b1')

    expect(audio.src).toBe('https://books.test/api/items/b1/file/f1?token=t')
    expect(audio.currentTime).toBe(42)
    expect(player.getState().duration).toBe(3600)
  })
})
