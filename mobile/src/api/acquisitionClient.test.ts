import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionStore } from '../auth/session'
import type { SessionVault } from '../auth/vault'
import { AcquisitionApiError, createMobileAcquisitionClient, formatAcquisitionError } from './acquisitionClient'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const loginResponse = { user: { id: 'u1', accessToken: 'access-1', refreshToken: 'refresh-1' } }
const refreshResponse = { user: { accessToken: 'new-access', refreshToken: 'new-refresh' } }
const searchResponse = { searchSessionId: 's1', results: [] }

describe('createMobileAcquisitionClient', () => {
  let vault: SessionVault
  let fetcher: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vault = {
      read: vi.fn().mockResolvedValue(null),
      write: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined)
    }
    fetcher = vi.fn()
  })

  it('uses the ABS bearer access token for gateway calls', async () => {
    fetcher.mockResolvedValueOnce(json(loginResponse)).mockResolvedValueOnce(json(searchResponse))
    const session = new SessionStore({ vault, fetcher: fetcher as unknown as typeof fetch })
    await session.login('https://books.test', 'scott', 'password')

    const client = createMobileAcquisitionClient(session, fetcher as unknown as typeof fetch)
    await expect(client.searchAudiobooks('lib1', 'Project Hail Mary')).resolves.toEqual(searchResponse)

    const [url, init] = fetcher.mock.calls[1] as [string, RequestInit]
    expect(url).toContain('/acquisition-api/v1/search/audiobooks')
    expect((init.headers as Headers).get('authorization')).toBe('Bearer access-1')
  })

  it('refreshes once and retries after a 401, mirroring the ABS client', async () => {
    fetcher
      .mockResolvedValueOnce(json(loginResponse))
      .mockResolvedValueOnce(json({ code: 'unauthorized', message: 'expired' }, 401))
      .mockResolvedValueOnce(json(refreshResponse))
      .mockResolvedValueOnce(json(searchResponse))

    const session = new SessionStore({ vault, fetcher: fetcher as unknown as typeof fetch })
    await session.login('https://books.test', 'scott', 'password')

    const client = createMobileAcquisitionClient(session, fetcher as unknown as typeof fetch)
    await expect(client.searchAudiobooks('lib1', 'q')).resolves.toEqual(searchResponse)
    expect(fetcher).toHaveBeenCalledTimes(4)
  })

  it('throws when constructed without an authenticated session', () => {
    const session = new SessionStore({ vault, fetcher: fetcher as unknown as typeof fetch })
    expect(() => createMobileAcquisitionClient(session)).toThrow()
  })
})

describe('formatAcquisitionError', () => {
  it('maps known gateway error codes to stable copy', () => {
    expect(formatAcquisitionError(new AcquisitionApiError(404, 'release_not_found', 'nope'))).toBe('That release could not be found.')
  })

  it('falls back to a generic message for unknown errors', () => {
    expect(formatAcquisitionError(new Error('boom'))).toBe('Something went wrong. Please try again.')
  })
})
