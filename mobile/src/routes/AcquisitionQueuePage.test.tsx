import type { Acquisition } from '@abs/acquisition-contract'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { MobileAcquisitionClient } from '../api/acquisitionClient'
import { AuthContext, type AuthContextValue } from '../auth/AuthProvider'
import { AcquisitionProvider } from '../contexts/AcquisitionContext'
import AcquisitionQueuePage from './AcquisitionQueuePage'

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

function renderQueue(client: Partial<MobileAcquisitionClient>) {
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
        <MemoryRouter initialEntries={['/library/lib1/acquisition-queue']}>
          <Routes>
            <Route path="/library/:libraryId/acquisition-queue" element={<AcquisitionQueuePage />} />
            <Route path="/library/:libraryId/item/:itemId" element={<p>Book details</p>} />
          </Routes>
        </MemoryRouter>
      </AcquisitionProvider>
    </AuthContext.Provider>
  )
}

describe('AcquisitionQueuePage', () => {
  it('opens an available acquisition by its abs item id, keyed by opaque id not title', async () => {
    const listAcquisitions = vi.fn().mockResolvedValue([
      acquisition({ id: 'acq-1', title: 'Project Hail Mary', state: 'available', absItemId: 'abs1' }),
      acquisition({ id: 'acq-2', title: 'Project Hail Mary', state: 'downloading' })
    ])
    renderQueue({ listAcquisitions, status: vi.fn().mockResolvedValue(null) })

    const links = await screen.findAllByRole('link', { name: 'Open book to download' })
    expect(links).toHaveLength(1)
    expect(links[0]).toHaveAttribute('href', '/library/lib1/item/abs1')
  })

  it('says the queue is server-side, and tells the user to download to the device once an acquisition is available', async () => {
    const listAcquisitions = vi.fn().mockResolvedValue([
      acquisition({ id: 'acq-done', title: 'Done Book', state: 'available', absItemId: 'abs1' }),
      acquisition({ id: 'acq-busy', title: 'Busy Book', state: 'downloading' })
    ])
    renderQueue({ listAcquisitions, status: vi.fn().mockResolvedValue(null) })

    await screen.findByText('Done Book')
    expect(screen.getByTestId('acquisition-queue-explainer')).toHaveTextContent(/server library, not to this phone/i)

    const doneRow = screen.getByText('Done Book').closest('[data-testid="acquisition-row"]') as HTMLElement
    expect(within(doneRow).getByText('In server library')).toBeInTheDocument()
    expect(within(doneRow).getByTestId('acquisition-next-step')).toHaveTextContent(/download it to your device/i)

    // In-flight rows describe the server's fetch, not a device download, and carry no next-step prompt.
    const busyRow = screen.getByText('Busy Book').closest('[data-testid="acquisition-row"]') as HTMLElement
    expect(within(busyRow).getByText('Fetching to server')).toBeInTheDocument()
    expect(within(busyRow).queryByTestId('acquisition-next-step')).not.toBeInTheDocument()
  })

  it('falls back to wording only, with no link, when an available acquisition has no abs item id', async () => {
    const listAcquisitions = vi.fn().mockResolvedValue([acquisition({ id: 'acq-noid', title: 'No Id Book', state: 'available', absItemId: null })])
    renderQueue({ listAcquisitions, status: vi.fn().mockResolvedValue(null) })

    await screen.findByText('No Id Book')
    expect(screen.queryByRole('link', { name: 'Open book to download' })).not.toBeInTheDocument()
    expect(screen.getByTestId('acquisition-next-step')).toHaveTextContent(/find it in your library and download it to your device/i)
  })

  it('retries a failed acquisition and cancels a queued one, tracked per acquisition id', async () => {
    const user = userEvent.setup()
    const listAcquisitions = vi.fn().mockResolvedValue([
      acquisition({ id: 'acq-fail', title: 'Failed Book', state: 'failed', error: { code: 'download_error', message: 'oops', retryable: true, lastSuccessfulStage: null } }),
      acquisition({ id: 'acq-queued', title: 'Queued Book', state: 'queued' })
    ])
    const retryAcquisition = vi.fn().mockResolvedValue(acquisition({ id: 'acq-fail', title: 'Failed Book', state: 'submitted' }))
    const cancelAcquisition = vi.fn().mockResolvedValue(acquisition({ id: 'acq-queued', title: 'Queued Book', state: 'cancelled' }))

    renderQueue({ listAcquisitions, retryAcquisition, cancelAcquisition, status: vi.fn().mockResolvedValue(null) })

    await screen.findByText('Failed Book')
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(retryAcquisition).toHaveBeenCalledWith('acq-fail'))

    const queuedRow = screen.getByText('Queued Book').closest('[data-testid="acquisition-row"]') as HTMLElement
    await user.click(within(queuedRow).getByRole('button', { name: 'Cancel' }))
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: 'Yes, cancel' }))
    await waitFor(() => expect(cancelAcquisition).toHaveBeenCalledWith('acq-queued'))
  })
})
