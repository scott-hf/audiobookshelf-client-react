import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { AbsAdminClient, AbsApiError } from './absAdminClient'

const FIXTURE = JSON.parse(
  readFileSync(path.join(__dirname, '..', '..', 'test', 'fixtures', 'abs', 'library-items.json'), 'utf8')
)

const TOKEN = 'svc-token-do-not-leak'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function client(fetcher: typeof fetch, timeoutMs?: number): AbsAdminClient {
  return new AbsAdminClient({ baseUrl: 'http://abs:13378', serviceToken: TOKEN, fetcher, timeoutMs })
}

describe('AbsAdminClient', () => {
  it('scans one library and queries only that library', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse(FIXTURE))
    const subject = client(fetcher as unknown as typeof fetch)

    await subject.scanLibrary('lib1')
    await subject.listLibraryItems('lib1', { limit: 100, page: 0 })

    expect(fetcher).toHaveBeenNthCalledWith(1, 'http://abs:13378/api/libraries/lib1/scan', expect.objectContaining({ method: 'POST' }))
    expect(fetcher.mock.calls[1][0]).toContain('/api/libraries/lib1/items?')
    expect(fetcher.mock.calls[1][0]).toContain('minified=1')
  })

  it('sends the service token as a bearer header on every request', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    await client(fetcher as unknown as typeof fetch).scanLibrary('lib1')
    expect(fetcher.mock.calls[0][1].headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, accept: 'application/json' })
  })

  it('parses the real minified ABS item shape', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(FIXTURE))
    const items = await client(fetcher as unknown as typeof fetch).listLibraryItems('lib-test')
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      id: 'li_exact',
      libraryId: 'lib-test',
      path: '/library/Andy Weir/Project Hail Mary',
      relPath: 'Andy Weir/Project Hail Mary',
      addedAt: 1700000100000
    })
    expect(items[0].media?.metadata).toMatchObject({ title: 'Project Hail Mary', authorName: 'Andy Weir', asin: 'B08G9PRS1K' })
  })

  it('pages until a short page and stops', async () => {
    const full = { results: Array.from({ length: 100 }, (_, i) => makeItem(`li${i}`)), total: 150 }
    const rest = { results: Array.from({ length: 50 }, (_, i) => makeItem(`li1${i}`)), total: 150 }
    const fetcher = vi.fn().mockResolvedValueOnce(jsonResponse(full)).mockResolvedValueOnce(jsonResponse(rest))
    const items = await client(fetcher as unknown as typeof fetch).listAllLibraryItems('lib-test')
    expect(items).toHaveLength(150)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[1][0]).toContain('page=1')
  })

  it('rejects schema drift in a required field', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ results: [{ id: 'li1', libraryId: 'lib-test' }] }))
    await expect(client(fetcher as unknown as typeof fetch).listLibraryItems('lib-test')).rejects.toThrow()
  })

  it('accepts unknown extra fields (ABS adds keys across releases)', async () => {
    const item = { ...makeItem('li1'), someFutureField: { nested: true } }
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ results: [item] }))
    await expect(client(fetcher as unknown as typeof fetch).listLibraryItems('lib-test')).resolves.toHaveLength(1)
  })

  it('classifies non-2xx statuses without echoing the service token', async () => {
    for (const [status, code] of [
      [401, 'abs_unauthorized'],
      [403, 'abs_unauthorized'],
      [404, 'abs_not_found'],
      [500, 'abs_error']
    ] as const) {
      const fetcher = vi.fn().mockResolvedValue(jsonResponse({ error: `boom ${TOKEN}` }, status))
      const error = await client(fetcher as unknown as typeof fetch)
        .scanLibrary('lib1')
        .catch((e) => e as AbsApiError)
      expect(error).toBeInstanceOf(AbsApiError)
      expect(error.code).toBe(code)
      expect(error.status).toBe(status)
      expect(JSON.stringify({ message: error.message, stack: error.stack })).not.toContain(TOKEN)
    }
  })

  it('turns a transport failure into abs_unreachable without leaking the token', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error(`connect ECONNREFUSED with ${TOKEN}`))
    const error = await client(fetcher as unknown as typeof fetch)
      .scanLibrary('lib1')
      .catch((e) => e as AbsApiError)
    expect(error.code).toBe('abs_unreachable')
    expect(error.message).not.toContain(TOKEN)
  })

  it('aborts a hanging request and reports a timeout', async () => {
    const fetcher = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
        })
    )
    const error = await client(fetcher as unknown as typeof fetch, 10)
      .scanLibrary('lib1')
      .catch((e) => e as AbsApiError)
    expect(error.code).toBe('abs_unreachable')
    expect(error.message).toContain('timed out')
  })
})

function makeItem(id: string) {
  return {
    id,
    libraryId: 'lib-test',
    path: `/library/x/${id}`,
    relPath: `x/${id}`,
    addedAt: 1700000000000,
    media: { metadata: { title: id, authorName: 'x' } }
  }
}
