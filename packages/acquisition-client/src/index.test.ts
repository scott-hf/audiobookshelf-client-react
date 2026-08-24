import { describe, expect, it, vi } from 'vitest'
import { createAcquisitionClient } from './index'

describe('acquisition client', () => {
  it('sends bearer auth and parses status', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          version: '1.0.0',
          ready: true,
          libraries: [{ id: 'lib1', enabled: true }]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    )
    const client = createAcquisitionClient({
      baseUrl: 'https://books.test/acquisition-api/v1',
      getAccessToken: async () => 'token',
      fetcher
    })
    await expect(client.status()).resolves.toMatchObject({ ready: true })
    expect(fetcher).toHaveBeenCalledWith(
      'https://books.test/acquisition-api/v1/status',
      expect.objectContaining({
        headers: expect.any(Headers),
        credentials: 'include'
      })
    )
    expect((fetcher.mock.calls[0][1].headers as Headers).get('authorization')).toBe('Bearer token')
  })
})
