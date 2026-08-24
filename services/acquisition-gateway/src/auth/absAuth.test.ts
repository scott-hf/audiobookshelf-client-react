import { describe, expect, it, vi } from 'vitest'
import { createAbsAuth, extractAccessToken } from './absAuth'

describe('extractAccessToken', () => {
  it('prefers a bearer token over an access_token cookie', () => {
    expect(extractAccessToken({ authorization: 'Bearer mobile-token', cookie: 'access_token=web-token' })).toBe(
      'mobile-token'
    )
  })

  it('falls back to the access_token cookie when no bearer is present', () => {
    expect(extractAccessToken({ cookie: 'other=1; access_token=web-token; more=2' })).toBe('web-token')
  })

  it('returns null when neither is present', () => {
    expect(extractAccessToken({})).toBeNull()
  })
})

describe('createAbsAuth', () => {
  it('accepts bearer before access_token cookie and fails closed on ABS denial', async () => {
    const validate = vi.fn().mockResolvedValue({ id: 'u1', librariesAccessible: ['lib1'], isActive: true })
    const auth = createAbsAuth({ validate })
    await expect(
      auth({ headers: { authorization: 'Bearer mobile-token', cookie: 'access_token=web-token' } })
    ).resolves.toMatchObject({ id: 'u1' })
    expect(validate).toHaveBeenCalledWith('mobile-token')

    validate.mockRejectedValueOnce(new Error('401'))
    await expect(auth({ headers: { cookie: 'access_token=bad' } })).rejects.toMatchObject({ statusCode: 401 })
  })

  it('rejects a token with no active/valid user without caching', async () => {
    const validate = vi.fn().mockResolvedValue({ id: 'u1', isActive: false })
    const auth = createAbsAuth({ validate })
    await expect(auth({ headers: { authorization: 'Bearer inactive' } })).rejects.toMatchObject({ statusCode: 401 })
  })

  it('rejects when no token is present, never calling the validator', async () => {
    const validate = vi.fn()
    const auth = createAbsAuth({ validate })
    await expect(auth({ headers: {} })).rejects.toMatchObject({ statusCode: 401 })
    expect(validate).not.toHaveBeenCalled()
  })

  it('caches a successful validation by token fingerprint for 30 seconds and never caches a failure', async () => {
    let now = 0
    const validate = vi.fn().mockResolvedValue({ id: 'u2', isActive: true })
    const auth = createAbsAuth({ validate, now: () => now })

    await auth({ headers: { authorization: 'Bearer t2' } })
    await auth({ headers: { authorization: 'Bearer t2' } })
    expect(validate).toHaveBeenCalledTimes(1)

    now = 29_999
    await auth({ headers: { authorization: 'Bearer t2' } })
    expect(validate).toHaveBeenCalledTimes(1)

    now = 30_001
    await auth({ headers: { authorization: 'Bearer t2' } })
    expect(validate).toHaveBeenCalledTimes(2)

    validate.mockRejectedValueOnce(new Error('denied'))
    await expect(auth({ headers: { authorization: 'Bearer bad-token' } })).rejects.toMatchObject({ statusCode: 401 })
    validate.mockResolvedValueOnce({ id: 'u3', isActive: true })
    await auth({ headers: { authorization: 'Bearer bad-token' } })
    // The failed call above must not have been cached -- this is a fresh validator call.
    expect(validate).toHaveBeenCalledTimes(4)
  })
})
