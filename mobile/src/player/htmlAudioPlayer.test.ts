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

/** play() awaits its own teardown before calling startSession, so the deferred resolvers are
 * not registered synchronously -- let the microtask queue drain until they show up. */
async function waitForPending(deferred: unknown[], count: number): Promise<void> {
  for (let i = 0; i < 50 && deferred.length < count; i++) {
    await Promise.resolve()
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

  it('leaves only one audio element playing when play() is re-entered before the session resolves', async () => {
    // Reproduces the orphaned-audio bug: React StrictMode double-invokes PlayerPage's effect,
    // so play() ran twice concurrently. Each call awaited startSession, then assigned
    // this.audio -- the first element stayed playing with nothing holding a reference to it,
    // and its ABS session was never closed.
    const created: FakeAudio[] = []
    const deferred: Array<(value: ReturnType<typeof session>) => void> = []
    ;(api.startSession as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((resolve) => deferred.push(resolve))
    )

    const player = new HtmlAudioPlayer({
      api,
      createAudio: () => {
        const a = new FakeAudio()
        created.push(a)
        return a
      }
    })

    const first = player.play('b1')
    const second = player.play('b1')
    await waitForPending(deferred, 1)

    deferred[0]({ id: 's1', currentTime: 0, audioTracks: [{ index: 0, contentUrl: '/api/items/b1/file/f1', duration: 3600 }] })
    await Promise.all([first, second])

    // Before the fix this was 2 elements, both playing, with only the second reachable.
    expect(created.filter((a) => !a.paused)).toHaveLength(1)
    // The superseded attempt bails before opening a session at all, so the server never sees
    // the second playback session that used to be leaked.
    expect(api.startSession).toHaveBeenCalledTimes(1)
    expect(player.getState().status).toBe('playing')
  })

  it('closes the session it opened if superseded while the audio element is starting', async () => {
    ;(api.startSession as ReturnType<typeof vi.fn>).mockResolvedValue(
      session({ id: 's1', audioTracks: [{ contentUrl: '/api/items/b1/file/f1', duration: 3600 }] })
    )

    // Hold the first element's play() open so a second play() can supersede it after its ABS
    // session already exists -- the branch that has to hand the session back.
    let releaseFirstPlay: () => void = () => {}
    const firstAudio = new FakeAudio()
    const originalPlay = firstAudio.play.bind(firstAudio)
    firstAudio.play = () =>
      new Promise<void>((resolve) => {
        releaseFirstPlay = () => {
          void originalPlay()
          resolve()
        }
      })

    const created: FakeAudio[] = [firstAudio]
    let handedOutFirst = false
    const player = new HtmlAudioPlayer({
      api,
      createAudio: () => {
        if (!handedOutFirst) {
          handedOutFirst = true
          return firstAudio
        }
        const a = new FakeAudio()
        created.push(a)
        return a
      }
    })

    const first = player.play('b1')
    await waitForPending([], 0)
    await Promise.resolve()
    const second = player.play('b1')
    releaseFirstPlay()
    await Promise.all([first, second])

    expect(firstAudio.paused).toBe(true)
    expect(api.closeSession).toHaveBeenCalledWith('s1', expect.any(Object))
  })

  it('stops playback when close() lands while play() is still in flight', async () => {
    const created: FakeAudio[] = []
    const deferred: Array<(value: ReturnType<typeof session>) => void> = []
    ;(api.startSession as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((resolve) => deferred.push(resolve))
    )

    const player = new HtmlAudioPlayer({
      api,
      createAudio: () => {
        const a = new FakeAudio()
        created.push(a)
        return a
      }
    })

    const playing = player.play('b1')
    await waitForPending(deferred, 1)
    await player.close()
    deferred[0]({ id: 's1', currentTime: 0, audioTracks: [{ index: 0, contentUrl: '/api/items/b1/file/f1', duration: 3600 }] })
    await playing

    expect(created.every((a) => a.paused)).toBe(true)
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
