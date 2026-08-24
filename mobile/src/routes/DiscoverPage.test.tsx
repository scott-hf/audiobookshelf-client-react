import type { Acquisition, SearchRelease, SearchResponse } from '@abs/acquisition-contract'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { MobileAcquisitionClient } from '../api/acquisitionClient'
import { AuthContext, type AuthContextValue } from '../auth/AuthProvider'
import { AcquisitionProvider } from '../contexts/AcquisitionContext'
import AcquisitionQueuePage from './AcquisitionQueuePage'
import DiscoverPage from './DiscoverPage'

function release(overrides: Partial<SearchRelease> & { releaseId: string; title: string }): SearchRelease {
  return {
    author: 'Andy Weir',
    narrators: [],
    format: 'm4b',
    sizeBytes: null,
    durationSeconds: null,
    sourceLabel: 'AudioBookBay',
    qualityLabel: 'V0',
    seeders: null,
    coverUrl: null,
    alreadyOwned: false,
    existingAbsItemId: null,
    requestable: true,
    ...overrides
  }
}

function acquisition(overrides: Partial<Acquisition> & { id: string }): Acquisition {
  return {
    libraryId: 'lib1',
    title: 'Project Hail Mary',
    author: 'Andy Weir',
    state: 'queued',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

function renderDiscover(client: Partial<MobileAcquisitionClient>) {
  const authValue: AuthContextValue = {
    state: { status: 'authenticated', serverUrl: 'https://books.test' },
    client: {} as AuthContextValue['client'],
    acquisitionClient: client as MobileAcquisitionClient,
    login: vi.fn(),
    logout: vi.fn()
  }
  return render(
    <AuthContext.Provider value={authValue}>
      <AcquisitionProvider>
        <MemoryRouter initialEntries={['/library/lib1/discover']}>
          <Routes>
            <Route path="/library/:libraryId/discover" element={<DiscoverPage />} />
            <Route path="/library/:libraryId/acquisition-queue" element={<AcquisitionQueuePage />} />
          </Routes>
        </MemoryRouter>
      </AcquisitionProvider>
    </AuthContext.Provider>
  )
}

describe('DiscoverPage', () => {
  it('searches, shows results, and requires confirmation before acquiring', async () => {
    const user = userEvent.setup()
    const searchAudiobooks = vi.fn().mockResolvedValue({
      searchSessionId: 'search-1',
      results: [release({ releaseId: 'rel-1', title: 'Project Hail Mary' })]
    } satisfies SearchResponse)
    const createAcquisition = vi.fn().mockResolvedValue(acquisition({ id: 'acq-1' }))

    renderDiscover({ searchAudiobooks, createAcquisition, listAcquisitions: vi.fn().mockResolvedValue([]), status: vi.fn().mockResolvedValue(null) })

    await user.type(screen.getByLabelText('Search audiobooks'), 'Project Hail Mary')
    await user.click(screen.getByRole('button', { name: 'Search' }))

    expect(await screen.findByText('Project Hail Mary')).toBeInTheDocument()
    expect(searchAudiobooks).toHaveBeenCalledWith('lib1', 'Project Hail Mary')

    await user.click(screen.getByRole('button', { name: 'Acquire' }))
    expect(createAcquisition).not.toHaveBeenCalled()
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Acquire' }))
    await waitFor(() => expect(createAcquisition).toHaveBeenCalledTimes(1))
    expect(createAcquisition).toHaveBeenCalledWith(
      'lib1',
      expect.objectContaining({ searchSessionId: 'search-1', releaseId: 'rel-1', idempotencyKey: expect.any(String) })
    )
  })

  it('disables Acquire for non-requestable releases', async () => {
    const user = userEvent.setup()
    const searchAudiobooks = vi.fn().mockResolvedValue({
      searchSessionId: 'search-1',
      results: [release({ releaseId: 'rel-2', title: 'Locked Release', requestable: false })]
    } satisfies SearchResponse)

    renderDiscover({ searchAudiobooks, createAcquisition: vi.fn(), listAcquisitions: vi.fn().mockResolvedValue([]), status: vi.fn().mockResolvedValue(null) })

    await user.type(screen.getByLabelText('Search audiobooks'), 'q')
    await user.click(screen.getByRole('button', { name: 'Search' }))

    expect(await screen.findByText('Locked Release')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Acquire' })).toBeDisabled()
  })
})
