import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAbsClient } from '../api/absClient'
import { normalizeServerUrl, SessionStore } from './session'
import type { SessionVault } from './vault'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const loginResponse = { user: { id: 'u1', accessToken: 'access-1', refreshToken: 'refresh-1' } }
const refreshResponse = { user: { accessToken: 'new-access', refreshToken: 'new-refresh' } }
const librariesResponse = { libraries: [{ id: 'lib1', name: 'Books', mediaType: 'book' }] }

describe('normalizeServerUrl', () => {
  it('defaults to https and strips trailing slashes', () => {
    expect(normalizeServerUrl('books.test/')).toBe('https://books.test')
    expect(normalizeServerUrl('https://books.test//')).toBe('https://books.test')
  })

  it('preserves an explicit scheme and port', () => {
    expect(normalizeServerUrl('http://books.test:13378/')).toBe('http://books.test:13378')
  })
})

describe('SessionStore', () => {
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

  it('logs in, stores tokens, and retries one 401 after refresh', async () => {
    fetcher
      .mockResolvedValueOnce(json(loginResponse))
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(json(refreshResponse))
      .mockResolvedValueOnce(json(librariesResponse))

    const session = new SessionStore({ vault, fetcher: fetcher as unknown as typeof fetch })
    await session.login('https://books.test', 'scott', 'password')

    const client = createAbsClient({ session, fetcher: fetcher as unknown as typeof fetch })
    await expect(client.getLibraries()).resolves.toEqual(librariesResponse)

    expect(vault.write).toHaveBeenLastCalledWith(expect.objectContaining({ accessToken: 'new-access', refreshToken: 'new-refresh' }))
    expect(fetcher).toHaveBeenCalledTimes(4)
  })

  it('surfaces the original 401 when refresh fails', async () => {
    fetcher.mockResolvedValueOnce(json(loginResponse)).mockResolvedValueOnce(new Response('', { status: 401 })).mockResolvedValueOnce(new Response('', { status: 401 }))

    const session = new SessionStore({ vault, fetcher: fetcher as unknown as typeof fetch })
    await session.login('https://books.test', 'scott', 'password')

    const client = createAbsClient({ session, fetcher: fetcher as unknown as typeof fetch })
    await expect(client.getLibraries()).rejects.toMatchObject({ status: 401 })
  })

  it('restores a persisted session from the vault without a network call', async () => {
    vault.read = vi.fn().mockResolvedValue({ serverUrl: 'https://books.test', accessToken: 'a', refreshToken: 'r' })
    const session = new SessionStore({ vault, fetcher: fetcher as unknown as typeof fetch })
    const state = await session.restore()
    expect(state).toEqual({ status: 'authenticated', serverUrl: 'https://books.test' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('clears the vault and session state on logout', async () => {
    fetcher.mockResolvedValueOnce(json(loginResponse))
    const session = new SessionStore({ vault, fetcher: fetcher as unknown as typeof fetch })
    await session.login('https://books.test', 'scott', 'password')
    await session.logout()
    expect(vault.clear).toHaveBeenCalledTimes(1)
    expect(session.getState()).toEqual({ status: 'unauthenticated', serverUrl: null })
  })

  it('never logs access or refresh tokens', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    fetcher.mockResolvedValueOnce(json({ user: { id: 'u1', accessToken: 'secret-access', refreshToken: 'secret-refresh' } }))

    const session = new SessionStore({ vault, fetcher: fetcher as unknown as typeof fetch })
    await session.login('https://books.test', 'scott', 'password')

    const logged = [...logSpy.mock.calls, ...errorSpy.mock.calls].flat().join(' ')
    expect(logged).not.toContain('secret-access')
    expect(logged).not.toContain('secret-refresh')

    logSpy.mockRestore()
    errorSpy.mockRestore()
  })
})
