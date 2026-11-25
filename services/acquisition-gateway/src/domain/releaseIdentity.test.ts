import { SearchReleaseSchema } from '@abs/acquisition-contract'
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
  it('maps a live AudioBookBay row: legacy sentinels on the wire, provider label, no invented size', () => {
    const release = toPublicRelease(
      row({ indexer: 'AudioBookBay', size_human: '?', in_library: false, score: 55, abb_url: '/abss/the-children-of-hurin-jrr-tolkien/' }),
      RELEASE_ID
    )

    // The legacy pair stays unfixed on the wire (an older sideloaded client needs both); the
    // clients suppress the duplicate pills.
    expect(release.format).toBe('unknown')
    expect(release.qualityLabel).toBe('Unknown')
    expect(release.sizeBytes).toBeNull()
    expect(release.sizeLabel).toBeNull()
    expect(release.sourceLabel).toBe('AudioBookBay')
    expect(release.requestable).toBe(true)
  })

  it('emits the legacy fields AND the additive ones, so old and new clients both work', () => {
    const release = toPublicRelease(row({ indexer: 'AudioBookBay', format: 'm4b', size_human: ' 1.2 GB ' }), RELEASE_ID)

    expect(release).toMatchObject({ format: 'm4b', qualityLabel: 'M4B', sizeLabel: '1.2 GB', sourceLabel: 'AudioBookBay' })
    // An old client does `format.toUpperCase()`: it must never see null or undefined.
    expect(typeof release.format).toBe('string')
    expect(typeof release.qualityLabel).toBe('string')
  })

  it('output satisfies the contract schema an old client bundles (minus sizeLabel)', () => {
    const release = toPublicRelease(row({ indexer: 'AudioBookBay' }), RELEASE_ID)

    expect(SearchReleaseSchema.omit({ sizeLabel: true }).safeParse(release).success).toBe(true)
    expect(SearchReleaseSchema.safeParse(release).success).toBe(true)
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

  describe('format and qualityLabel (legacy wire fields)', () => {
    it('are the sentinels "unknown" / "Unknown", never null, when the source sends no format', () => {
      const release = toPublicRelease(row({}), RELEASE_ID)
      expect(release.format).toBe('unknown')
      expect(release.qualityLabel).toBe('Unknown')
    })

    it('pass a real format through, with qualityLabel derived from it', () => {
      const release = toPublicRelease(row({ format: 'm4b' }), RELEASE_ID)
      expect(release.format).toBe('m4b')
      expect(release.qualityLabel).toBe('M4B')
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
