import { describe, expect, it } from 'vitest'
import { AcquisitionSchema, CreateAcquisitionBodySchema } from './index'

describe('acquisition contract', () => {
  it('rejects progress outside 0..100', () => {
    expect(() =>
      AcquisitionSchema.parse({
        id: 'a1',
        libraryId: 'lib1',
        title: 'Book',
        author: 'Author',
        state: 'downloading',
        progressPercent: 101,
        createdAt: '2026-08-24T00:00:00.000Z',
        updatedAt: '2026-08-24T00:00:00.000Z'
      })
    ).toThrow()
  })

  it('requires opaque release identity and idempotency', () => {
    expect(
      CreateAcquisitionBodySchema.parse({
        searchSessionId: 'search_12345678',
        releaseId: 'release_12345678',
        idempotencyKey: crypto.randomUUID()
      })
    ).toBeTruthy()
  })
})
