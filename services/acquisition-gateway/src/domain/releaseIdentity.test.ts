import { describe, expect, it } from 'vitest'
import { LibrarrSearchResultSchema } from '../adapters/librarrSchemas'
import { toPublicRelease } from './releaseIdentity'

const RELEASE_ID = 'release_test_0000000001'

// Parsed through the real schema so defaults (`author`, `in_library`) apply as they do in production.
function row(fields: Record<string, unknown>) {
  return LibrarrSearchResultSchema.parse({ source: 'audiobook', title: 'The Children of Hurin - J.R.R. Tolkien', ...fields })
}

describe('toPublicRelease', () => {
  // The full shape of a live AudioBookBay search row (Tolkien search): the listing carries no
  // format, author, size or seeders -- those exist only on the /abss/ detail page.
  it('maps a live AudioBookBay row without inventing format, size or a duplicate quality label', () => {
    const release = toPublicRelease(
      row({ indexer: 'AudioBookBay', size_human: '?', in_library: false, score: 55, abb_url: '/abss/the-children-of-hurin-jrr-tolkien/' }),
      RELEASE_ID
    )

    expect(release.format).toBeNull()
    expect(release.sizeBytes).toBeNull()
    expect(release.sizeLabel).toBeNull()
    expect(release.sourceLabel).toBe('AudioBookBay')
    expect(release.requestable).toBe(true)
    expect(release).not.toHaveProperty('qualityLabel')
  })

  describe('sourceLabel', () => {
    it('prefers the provider (`indexer`) over the search tab (`source`)', () => {
      expect(toPublicRelease(row({ indexer: 'AudioBookBay' }), RELEASE_ID).sourceLabel).toBe('AudioBookBay')
    })

    it('falls back to `source` when the row has no indexer', () => {
      expect(toPublicRelease(row({ source: 'prowlarr_audiobook' }), RELEASE_ID).sourceLabel).toBe('prowlarr_audiobook')
    })

    it('falls back to `source` when the indexer is blank, so the pill is never empty', () => {
      expect(toPublicRelease(row({ indexer: '   ' }), RELEASE_ID).sourceLabel).toBe('audiobook')
    })
  })

  describe('format', () => {
    it('is null, not the string "unknown", when the source sends none', () => {
      expect(toPublicRelease(row({}), RELEASE_ID).format).toBeNull()
    })

    it('passes a real format through', () => {
      expect(toPublicRelease(row({ format: 'm4b' }), RELEASE_ID).format).toBe('m4b')
    })
  })

  describe('sizeLabel', () => {
    it.each(['?', '', '   ', 'unknown', 'UNKNOWN', 'Unknown', 'n/a', 'N/A', ' ? '])('is null for the no-information value %j', (sizeHuman) => {
      expect(toPublicRelease(row({ size_human: sizeHuman }), RELEASE_ID).sizeLabel).toBeNull()
    })

    it('is null when the source sends no size_human', () => {
      expect(toPublicRelease(row({}), RELEASE_ID).sizeLabel).toBeNull()
    })

    it('passes a real size through, trimmed', () => {
      expect(toPublicRelease(row({ size_human: '1.2 GB' }), RELEASE_ID).sizeLabel).toBe('1.2 GB')
      expect(toPublicRelease(row({ size_human: '  1.2 GB \n' }), RELEASE_ID).sizeLabel).toBe('1.2 GB')
    })
  })

  describe('sizeBytes', () => {
    it('still carries a real numeric size', () => {
      expect(toPublicRelease(row({ size: 742000000 }), RELEASE_ID).sizeBytes).toBe(742000000)
    })

    it('is independent of size_human: both can be present', () => {
      const release = toPublicRelease(row({ size: 742000000, size_human: '707.7 MB' }), RELEASE_ID)
      expect(release.sizeBytes).toBe(742000000)
      expect(release.sizeLabel).toBe('707.7 MB')
    })
  })
})
