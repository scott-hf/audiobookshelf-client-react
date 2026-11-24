import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionStore } from '../auth/session'
import { AbsApiError, createAbsClient, REQUEST_TIMEOUT_MS, SESSION_START_TIMEOUT_MS } from './absClient'

const session = {
  getServerUrl: () => 'https://books.test',
  getAccessToken: () => 'token',
  refresh: vi.fn().mockResolvedValue(false)
} as unknown as SessionStore

/** A fetch that never answers on its own and rejects the way a real one does when aborted. */
function hangingFetch() {
  return vi.fn((_url: unknown, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new DOMException('aborted', 'AbortError')))
    })
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createAbsClient request timeout', () => {
  it('aborts a hung request with a typed timeout error instead of waiting forever', async () => {
    const timeout = new AbortController()
    const spy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
    const fetcher = hangingFetch()
    const client = createAbsClient({ session, fetcher: fetcher as unknown as typeof fetch })

    const pending = client.getLibraries()
    timeout.abort(new DOMException('timed out', 'TimeoutError'))

    await expect(pending).rejects.toBeInstanceOf(AbsApiError)
    await expect(pending).rejects.toMatchObject({ status: 408 })
    expect(spy).toHaveBeenCalledWith(REQUEST_TIMEOUT_MS)
    expect(fetcher.mock.calls[0][1]?.signal).toBe(timeout.signal)
  })

  it('gives startSession a longer timeout than ordinary calls', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout')
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 's1', currentTime: 0, audioTracks: [] }), { status: 200 }))
    const client = createAbsClient({ session, fetcher: fetcher as unknown as typeof fetch })

    await client.startSession('b1', {
      deviceInfo: { clientName: 'ShelfDroid', deviceId: 'd' },
      supportedMimeTypes: [],
      mediaPlayer: 'exo',
      forceTranscode: false,
      forceDirectPlay: false
    })

    expect(spy).toHaveBeenCalledWith(SESSION_START_TIMEOUT_MS)
    expect(SESSION_START_TIMEOUT_MS).toBeGreaterThan(REQUEST_TIMEOUT_MS)
  })

  it('does not relabel an ordinary failure as a timeout', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('nope', { status: 500 }))
    const client = createAbsClient({ session, fetcher: fetcher as unknown as typeof fetch })

    await expect(client.getLibraries()).rejects.toMatchObject({ status: 500, message: 'nope' })
  })
})
