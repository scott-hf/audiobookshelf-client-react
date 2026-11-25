import type { SearchRelease } from '@abs/acquisition-contract'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import ReleaseCard from './ReleaseCard'

function release(overrides: Partial<SearchRelease> = {}): SearchRelease {
  return {
    releaseId: 'release_12345678',
    title: 'The Children of Hurin - J.R.R. Tolkien',
    author: '',
    narrators: [],
    format: null,
    sizeBytes: null,
    sizeLabel: null,
    durationSeconds: null,
    sourceLabel: 'AudioBookBay',
    seeders: null,
    coverUrl: null,
    alreadyOwned: false,
    existingAbsItemId: null,
    requestable: true,
    ...overrides
  }
}

/** Text of every pill in the card's badge row, in order. */
function renderPills(overrides: Partial<SearchRelease> = {}): string[] {
  render(<ReleaseCard release={release(overrides)} onAcquire={vi.fn()} />)
  const row = screen.getByTestId('release-card').querySelector('.flex-wrap')
  return Array.from(row?.children ?? []).map((pill) => pill.textContent ?? '')
}

describe('ReleaseCard pills', () => {
  it('renders no format pill when the format is null: a live AudioBookBay row is just its source', () => {
    expect(renderPills({ format: null })).toEqual(['AudioBookBay'])
    expect(screen.queryByText(/unknown/i)).not.toBeInTheDocument()
  })

  it('renders exactly one pill for a known format (no duplicate quality pill)', () => {
    const pills = renderPills({ format: 'm4b' })

    expect(pills.filter((text) => text.toLowerCase() === 'm4b')).toEqual(['M4B'])
    expect(pills).toEqual(['M4B', 'AudioBookBay'])
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
})
