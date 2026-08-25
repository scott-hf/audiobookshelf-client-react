import { describe, expect, it } from 'vitest'
import type { AbsAudioPlayerLoadOptions, AbsAudioPlayerPlugin } from '../native/absAudioPlayerPlugin'
import type { NativePlayerState, PlayerSnapshot } from './playerTypes'
import { createNativeAudioPlayer } from './nativeAudioPlayer'

/** In-memory fake of the Capacitor bridge: records calls and lets the test drive
 * `playerState` events directly, without a real native runtime. */
function fakeNativePlugin() {
  const listeners: Array<(state: NativePlayerState) => void> = []
  const calls: { load: AbsAudioPlayerLoadOptions[] } = { load: [] }

  const plugin: AbsAudioPlayerPlugin & { emit: (event: 'playerState', state: NativePlayerState) => void; calls: typeof calls } = {
    calls,
    async load(options) {
      calls.load.push(options)
    },
    async play() {},
    async pause() {},
    async seek() {},
    async setRate() {},
    async stop() {},
    async setSleepTimer() {},
    async getState() {
      return { status: 'idle', itemId: null, currentTime: 0, duration: 0, error: null, rate: 1 } satisfies PlayerSnapshot
    },
    async addListener(event, listener) {
      if (event === 'playerState') listeners.push(listener)
      return { remove: async () => {} }
    },
    emit(event, state) {
      if (event !== 'playerState') return
      for (const listener of listeners) listener(state)
    }
  }
  return plugin
}

const sessionFixture: AbsAudioPlayerLoadOptions = {
  session: { id: 'session-1', currentTime: 0, audioTracks: [{ index: 0, contentUrl: '/fake/track.mp3', duration: 3600 }] },
  accessToken: 'fake-token',
  serverUrl: 'https://fake.example.test'
}

describe('createNativeAudioPlayer', () => {
  it('translates native events into the stable MobilePlayer contract', async () => {
    const plugin = fakeNativePlugin()
    const player = createNativeAudioPlayer(plugin)
    const states: PlayerSnapshot[] = []
    player.subscribe((state) => states.push(state))

    await player.load(sessionFixture)
    plugin.emit('playerState', { state: 'playing', currentTime: 42, duration: 3600, playbackRate: 1.25 })

    expect(states.at(-1)).toMatchObject({ status: 'playing', currentTime: 42, duration: 3600, rate: 1.25 })
    expect(plugin.calls.load).toEqual([sessionFixture])
  })

  it('clamps position into 0..duration and maps buffering/ended/error states', async () => {
    const plugin = fakeNativePlugin()
    const player = createNativeAudioPlayer(plugin)
    const states: PlayerSnapshot[] = []
    player.subscribe((state) => states.push(state))

    plugin.emit('playerState', { state: 'buffering', currentTime: -5, duration: 100, playbackRate: 1 })
    expect(states.at(-1)).toMatchObject({ status: 'buffering', currentTime: 0, duration: 100 })

    plugin.emit('playerState', { state: 'playing', currentTime: 150, duration: 100, playbackRate: 1 })
    expect(states.at(-1)).toMatchObject({ status: 'playing', currentTime: 100, duration: 100 })

    plugin.emit('playerState', { state: 'ended', currentTime: 100, duration: 100, playbackRate: 1 })
    expect(states.at(-1)).toMatchObject({ status: 'ended', error: null })

    plugin.emit('playerState', { state: 'error', currentTime: 10, duration: 100, playbackRate: 1, error: 'device offline' })
    expect(states.at(-1)).toMatchObject({ status: 'error', error: 'device offline' })
  })

  it('getState reflects the latest snapshot', async () => {
    const plugin = fakeNativePlugin()
    const player = createNativeAudioPlayer(plugin)
    plugin.emit('playerState', { state: 'paused', currentTime: 5, duration: 60, playbackRate: 1 })
    expect(player.getState()).toMatchObject({ status: 'paused', currentTime: 5, duration: 60 })
  })
})
