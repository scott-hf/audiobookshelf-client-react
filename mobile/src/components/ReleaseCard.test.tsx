import type { SearchRelease } from '@abs/acquisition-contract'
import { cleanup, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import ReleaseCard from './ReleaseCard'

// The wire format is deliberately the LEGACY one: `format` is the string 'unknown' when the source
// said nothing, and `qualityLabel` is still sent (derived from `format`) for older clients. The
// card is where the duplicate "UNKNOWN" / "Unknown" pills are suppressed.
function release(overrides: Partial<SearchRelease> = {}): SearchRelease {
  return {
    releaseId: 'release_12345678',
    title: 'The Children of Hurin - J.R.R. Tolkien',
    author: '',
    narrators: [],
    format: 'unknown',
    sizeBytes: null,
    sizeLabel: null,
    durationSeconds: null,
    sourceLabel: 'AudioBookBay',
    qualityLabel: 'Unknown',
    seeders: null,
    coverUrl: null,
    alreadyOwned: false,
    existingAbsItemId: null,
    requestable: true,
    ...overrides
  }
}

/** Text of every pill in the card's badge row, in order. */
function pillsOf(value: SearchRelease): string[] {
  render(<ReleaseCard release={value} onAcquire={vi.fn()} />)
  const row = screen.getByTestId('release-card').querySelector('.flex-wrap')
  return Array.from(row?.children ?? []).map((pill) => pill.textContent ?? '')
}

function renderPills(overrides: Partial<SearchRelease> = {}): string[] {
  return pillsOf(release(overrides))
}

describe('ReleaseCard pills', () => {
  it.each(['unknown', 'UNKNOWN', 'Unknown', '  unknown  ', '', '   '])('renders no format pill for the absent-format value %j: a live AudioBookBay row is just its source', (format) => {
    expect(renderPills({ format })).toEqual(['AudioBookBay'])
    expect(screen.queryByText(/unknown/i)).not.toBeInTheDocument()
  })

  it('renders exactly one pill for a known format (no duplicate quality pill)', () => {
    // The gateway still sends qualityLabel 'M4B' alongside format 'm4b'; it must not render.
    const pills = renderPills({ format: 'm4b', qualityLabel: 'M4B' })

    expect(pills.filter((text) => text.toLowerCase() === 'm4b')).toEqual(['M4B'])
    expect(pills).toEqual(['M4B', 'AudioBookBay'])
  })

  it('never renders qualityLabel: a release that still carries one shows exactly the expected pills', () => {
    expect(renderPills({ format: 'unknown', qualityLabel: 'Unknown' })).toEqual(['AudioBookBay'])
    cleanup()
    expect(renderPills({ format: 'mp3', qualityLabel: '320kbps' })).toEqual(['MP3', 'AudioBookBay'])
    expect(screen.queryByText('320kbps')).not.toBeInTheDocument()
  })

  it('shows sizeBytes pretty-printed, and it wins over sizeLabel', () => {
    const pills = renderPills({ sizeBytes: 742000000, sizeLabel: '1.2 GB' })

    expect(pills).toEqual(['707.6 MB', 'AudioBookBay'])
  })

  it('falls back to the raw sizeLabel when there is no sizeBytes', () => {
    expect(renderPills({ sizeBytes: null, sizeLabel: '1.2 GB' })).toEqual(['1.2 GB', 'AudioBookBay'])
  })

  it('renders no size pill when neither sizeBytes nor sizeLabel is set', () => {
    expect(renderPills({ sizeBytes: null, sizeLabel: null })).toEqual(['AudioBookBay'])
  })

  it('renders no size pill for a blank sizeLabel', () => {
    expect(renderPills({ sizeBytes: null, sizeLabel: '   ' })).toEqual(['AudioBookBay'])
  })

  it('tolerates an OLD gateway response with no sizeLabel key at all', () => {
    // An old gateway never sends `sizeLabel`. Build the object without the key (not `undefined`
    // assigned to it) so this is the shape that actually arrives after parsing.
    const { sizeLabel: _omitted, ...oldGatewayRelease } = release({ format: 'm4b', qualityLabel: 'M4B' })
    expect('sizeLabel' in oldGatewayRelease).toBe(false)

    expect(pillsOf(oldGatewayRelease)).toEqual(['M4B', 'AudioBookBay'])
  })
})
