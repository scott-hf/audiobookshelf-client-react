import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AbsClient } from '../api/absClient'
import { HtmlAudioPlayer } from './htmlAudioPlayer'
import type { AudioLike } from './playerTypes'

class ManualAudio implements AudioLike {
  src = ''
  currentTime = 0
  duration = 0
  paused = true
  play(): Promise<void> {
    this.paused = false
    return Promise.resolve()
  }
  pause(): void {
    this.paused = true
  }
}

function session(id: string, contentUrl: string, duration = 3600, currentTime = 0) {
  return { id, currentTime, audioTracks: [{ index: 0, contentUrl, duration }] }
}

function fakeApi(): AbsClient {
  return {
    getLibraries: vi.fn(),
    getLibraryItems: vi.fn(),
    getLibraryItem: vi.fn(),
    startSession: vi.fn(),
    syncSession: vi.fn().mockResolvedValue(undefined),
    closeSession: vi.fn().mockResolvedValue(undefined),
    authorizedStreamUrl: vi.fn((contentUrl: string) => `https://books.test${contentUrl}`)
  } as unknown as AbsClient
}

describe('progress sync', () => {
  let api: AbsClient
  let audio: ManualAudio

  beforeEach(() => {
    vi.useFakeTimers()
    api = fakeApi()
    audio = new ManualAudio()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('pausing syncs the current position immediately and stops the timer', async () => {
    ;(api.startSession as ReturnType<typeof vi.fn>).mockResolvedValue(session('s1', '/api/items/b1/file/f1'))
    const player = new HtmlAudioPlayer({ api, createAudio: () => audio })
    await player.play('b1')

    audio.currentTime = 7
    player.pause()

    expect(api.syncSession).toHaveBeenCalledWith('s1', expect.objectContaining({ currentTime: 7, timeListened: 7 }))
    expect(player.getState().status).toBe('paused')

    ;(api.syncSession as ReturnType<typeof vi.fn>).mockClear()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(api.syncSession).not.toHaveBeenCalled()
  })

  it('resuming restarts periodic sync from the paused position', async () => {
    ;(api.startSession as ReturnType<typeof vi.fn>).mockResolvedValue(session('s1', '/api/items/b1/file/f1'))
    const player = new HtmlAudioPlayer({ api, createAudio: () => audio })
    await player.play('b1')

    audio.currentTime = 10
    player.pause()
    ;(api.syncSession as ReturnType<typeof vi.fn>).mockClear()

    await player.resume()
    audio.currentTime = 25
    await vi.advanceTimersByTimeAsync(15_000)

    expect(api.syncSession).toHaveBeenCalledWith('s1', expect.objectContaining({ currentTime: 25, timeListened: 15 }))
  })

  it('seeking updates state without triggering a sync call', async () => {
    ;(api.startSession as ReturnType<typeof vi.fn>).mockResolvedValue(session('s1', '/api/items/b1/file/f1'))
    const player = new HtmlAudioPlayer({ api, createAudio: () => audio })
    await player.play('b1')
    ;(api.syncSession as ReturnType<typeof vi.fn>).mockClear()

    player.seek(120)
    expect(player.getState().currentTime).toBe(120)
    expect(api.syncSession).not.toHaveBeenCalled()
  })

  it('replacing the item closes the previous session before starting a new one', async () => {
    ;(api.startSession as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(session('s1', '/api/items/b1/file/f1'))
      .mockResolvedValueOnce(session('s2', '/api/items/b2/file/f1'))
    const player = new HtmlAudioPlayer({ api, createAudio: () => audio })

    await player.play('b1')
    audio.currentTime = 3
    await player.play('b2')

    expect(api.closeSession).toHaveBeenCalledWith('s1', expect.objectContaining({ currentTime: 3 }))
    expect(player.getState().itemId).toBe('b2')
  })
})
