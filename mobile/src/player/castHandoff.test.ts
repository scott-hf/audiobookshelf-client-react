import { describe, expect, it, vi } from 'vitest'
import type { AbsAudioPlayerPlugin } from '../native/absAudioPlayerPlugin'
import type { CastDisconnectedEvent, CastPlugin } from '../native/castPlugin'
import type { PlayerSnapshot } from './playerTypes'
import { createCastHandoffController, type CastSessionSource } from './castHandoff'

function snapshot(patch: Partial<PlayerSnapshot>): PlayerSnapshot {
  return { status: 'playing', itemId: 'item-1', currentTime: 0, duration: 3600, error: null, rate: 1, ...patch }
}

/** In-memory fake of the native ExoPlayer bridge -- mirrors `nativeAudioPlayer.test.ts`'s
 * `fakeNativePlugin` pattern (mock functions instead of a full listener registry, since
 * `castHandoff` only calls `getState`/`pause`/`seek`/`play` on it). */
function fakeNative(): AbsAudioPlayerPlugin {
  return {
    load: vi.fn().mockResolvedValue(undefined),
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn().mockResolvedValue(undefined),
    seek: vi.fn().mockResolvedValue(undefined),
    setRate: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    setSleepTimer: vi.fn().mockResolvedValue(undefined),
    getState: vi.fn().mockResolvedValue(snapshot({})),
    addListener: vi.fn().mockResolvedValue({ remove: async () => {} })
  } as unknown as AbsAudioPlayerPlugin
}

/** In-memory fake of the Cast bridge -- records `load` calls and lets the test drive a
 * `disconnected` event directly, without a real native runtime (same `emit` convention as
 * `nativeAudioPlayer.test.ts`'s fake). */
function fakeCastPlugin() {
  const listeners: Array<(event: CastDisconnectedEvent) => void> = []
  const plugin: CastPlugin & { emit: (event: 'disconnected', payload: CastDisconnectedEvent) => void } = {
    isAvailable: vi.fn().mockResolvedValue({ available: true }),
    load: vi.fn().mockResolvedValue(undefined),
    async addListener(event, listener) {
      if (event === 'disconnected') listeners.push(listener)
      return { remove: async () => {} }
    },
    emit(event, payload) {
      if (event !== 'disconnected') return
      for (const listener of listeners) listener(payload)
    }
  }
  return plugin
}

const sourceFixture: CastSessionSource = {
  contentUrl: 'https://abs.example.test/stream/session-1',
  contentType: 'audio/mpeg',
  title: 'Book One',
  accessToken: 'fake-token'
}

describe('createCastHandoffController', () => {
  it('moves position and rate to Cast then resumes native playback on disconnect', async () => {
    const native = fakeNative()
    ;(native.getState as ReturnType<typeof vi.fn>).mockResolvedValue(snapshot({ currentTime: 420, rate: 1.25, status: 'playing' }))
    const cast = fakeCastPlugin()
    const controller = createCastHandoffController(native, cast, () => sourceFixture)

    await controller.connectCast()

    expect(cast.load).toHaveBeenCalledWith(expect.objectContaining({ startTime: 420, rate: 1.25 }))
    expect(native.pause).toHaveBeenCalled()
    expect(controller.isCasting()).toBe(true)

    cast.emit('disconnected', { currentTime: 600 })
    await Promise.resolve()
    await Promise.resolve()

    expect(native.seek).toHaveBeenCalledWith({ seconds: 600 })
    expect(controller.isCasting()).toBe(false)
  })

  it('is a no-op when nothing is currently loaded', async () => {
    const native = fakeNative()
    const cast = fakeCastPlugin()
    const controller = createCastHandoffController(native, cast, () => null)

    await controller.connectCast()

    expect(cast.load).not.toHaveBeenCalled()
    expect(native.pause).not.toHaveBeenCalled()
    expect(controller.isCasting()).toBe(false)
  })
})
