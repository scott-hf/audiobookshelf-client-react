import type { Acquisition, SearchRelease, SearchResponse } from '@abs/acquisition-contract'
import { act, render, screen, waitFor, within } from '@testing-library/react'
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
    sizeLabel: null,
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

describe('DiscoverPage slow search', () => {
  // A real gateway search against this server's Librarr takes ~30s, so the wait itself is a
  // feature with requirements: it must explain itself and be escapable.
  it('explains the wait and lets the user cancel a search in flight', async () => {
    const user = userEvent.setup()
    let abortSignal: AbortSignal | undefined
    // Never resolves: stands in for a search still out at the indexers.
    const searchAudiobooks = vi.fn((_libraryId: string, _q: string, options?: { signal?: AbortSignal }) => {
      abortSignal = options?.signal
      return new Promise<SearchResponse>(() => {})
    })

    renderDiscover({ searchAudiobooks, listAcquisitions: vi.fn().mockResolvedValue([]), status: vi.fn().mockResolvedValue(null) })

    await user.type(screen.getByLabelText('Search audiobooks'), 'dune')
    await user.click(screen.getByRole('button', { name: 'Search' }))

    expect(await screen.findByTestId('discover-searching')).toBeInTheDocument()
    expect(screen.getByText('Searches run against external indexers and usually take 20-40 seconds.')).toBeInTheDocument()
    expect(abortSignal?.aborted).toBe(false)

    await user.click(screen.getByRole('button', { name: 'Cancel search' }))

    // The request is actually aborted, not merely hidden, and no error is shown for a cancel the
    // user asked for.
    expect(abortSignal?.aborted).toBe(true)
    await waitFor(() => expect(screen.queryByTestId('discover-searching')).not.toBeInTheDocument())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  // On the device the soft keyboard stayed up for the whole search and covered "Cancel search".
  it('drops input focus on submit so the soft keyboard cannot cover Cancel', async () => {
    const user = userEvent.setup()
    const searchAudiobooks = vi.fn(() => new Promise<SearchResponse>(() => {}))

    renderDiscover({ searchAudiobooks, listAcquisitions: vi.fn().mockResolvedValue([]), status: vi.fn().mockResolvedValue(null) })

    const input = screen.getByLabelText('Search audiobooks')
    await user.type(input, 'dune')
    expect(input).toHaveFocus()

    await user.click(screen.getByRole('button', { name: 'Search' }))

    expect(await screen.findByTestId('discover-searching')).toBeInTheDocument()
    expect(input).not.toHaveFocus()
  })

  it('aborts an in-flight search when the page unmounts', async () => {
    const user = userEvent.setup()
    let abortSignal: AbortSignal | undefined
    const searchAudiobooks = vi.fn((_libraryId: string, _q: string, options?: { signal?: AbortSignal }) => {
      abortSignal = options?.signal
      return new Promise<SearchResponse>(() => {})
    })

    const { unmount } = renderDiscover({ searchAudiobooks, listAcquisitions: vi.fn().mockResolvedValue([]), status: vi.fn().mockResolvedValue(null) })

    await user.type(screen.getByLabelText('Search audiobooks'), 'dune')
    await user.click(screen.getByRole('button', { name: 'Search' }))
    expect(await screen.findByTestId('discover-searching')).toBeInTheDocument()

    unmount()
    expect(abortSignal?.aborted).toBe(true)
  })

  // Search A, Cancel, search B, then A settles. A is no longer the live request, so it must not
  // touch B's spinner or B's results -- even though this fake (like a response already on the
  // wire when the abort lands) ignores the signal and resolves anyway.
  describe('a cancelled search settling after a newer one has started', () => {
    function deferred<T>() {
      let resolve!: (value: T) => void
      let reject!: (reason: unknown) => void
      const promise = new Promise<T>((res, rej) => {
        resolve = res
        reject = rej
      })
      return { promise, resolve, reject }
    }

    async function startSearchCancelSearchAgain() {
      const user = userEvent.setup()
      const a = deferred<SearchResponse>()
      const b = deferred<SearchResponse>()
      const searchAudiobooks = vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise)
      renderDiscover({ searchAudiobooks, listAcquisitions: vi.fn().mockResolvedValue([]), status: vi.fn().mockResolvedValue(null) })

      await user.type(screen.getByLabelText('Search audiobooks'), 'dune')
      await user.click(screen.getByRole('button', { name: 'Search' }))
      await user.click(await screen.findByRole('button', { name: 'Cancel search' }))
      await waitFor(() => expect(screen.queryByTestId('discover-searching')).not.toBeInTheDocument())

      await user.click(screen.getByRole('button', { name: 'Search' }))
      expect(await screen.findByTestId('discover-searching')).toBeInTheDocument()
      expect(searchAudiobooks).toHaveBeenCalledTimes(2)
      return { a, b }
    }

    it("does not let A's late success replace B's results or hide B's spinner", async () => {
      const { a, b } = await startSearchCancelSearchAgain()

      a.resolve({ searchSessionId: 'search-a', results: [release({ releaseId: 'rel-a', title: 'Stale Release' })] })
      // Give A's continuation every chance to run.
      await act(async () => {
        await Promise.resolve()
      })

      expect(screen.getByTestId('discover-searching')).toBeInTheDocument()
      expect(screen.queryByText('Stale Release')).not.toBeInTheDocument()

      b.resolve({ searchSessionId: 'search-b', results: [release({ releaseId: 'rel-b', title: 'Fresh Release' })] })

      expect(await screen.findByText('Fresh Release')).toBeInTheDocument()
      expect(screen.queryByTestId('discover-searching')).not.toBeInTheDocument()
      expect(screen.queryByText('Stale Release')).not.toBeInTheDocument()
    })

    it("does not let A's late failure show an error or hide B's spinner", async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { a, b } = await startSearchCancelSearchAgain()

      a.reject(new Error('indexers fell over'))
      await act(async () => {
        await Promise.resolve()
      })

      expect(screen.getByTestId('discover-searching')).toBeInTheDocument()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(consoleError).not.toHaveBeenCalled()

      b.resolve({ searchSessionId: 'search-b', results: [release({ releaseId: 'rel-b', title: 'Fresh Release' })] })
      expect(await screen.findByText('Fresh Release')).toBeInTheDocument()
      consoleError.mockRestore()
    })

    it("still shows B's own failure", async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { a, b } = await startSearchCancelSearchAgain()

      a.resolve({ searchSessionId: 'search-a', results: [] })
      b.reject(new Error('indexers fell over'))

      expect(await screen.findByRole('alert')).toBeInTheDocument()
      expect(screen.queryByTestId('discover-searching')).not.toBeInTheDocument()
      consoleError.mockRestore()
    })
  })
})

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
    // The third argument carries the cancellation signal the Cancel button and unmount both use.
    expect(searchAudiobooks).toHaveBeenCalledWith('lib1', 'Project Hail Mary', { signal: expect.any(AbortSignal) })

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

  describe('input sanitising', () => {
    const emptyResponse: SearchResponse = { searchSessionId: 'search-1', results: [] }
    const clientWith = (searchAudiobooks: ReturnType<typeof vi.fn>) => ({
      searchAudiobooks,
      createAcquisition: vi.fn(),
      listAcquisitions: vi.fn().mockResolvedValue([]),
      status: vi.fn().mockResolvedValue(null)
    })

    it('sends a padded query trimmed, and shows the trimmed text in the box afterwards', async () => {
      const user = userEvent.setup()
      const searchAudiobooks = vi.fn().mockResolvedValue(emptyResponse)
      renderDiscover(clientWith(searchAudiobooks))

      const box = screen.getByLabelText('Search audiobooks')
      await user.type(box, '   dune  {Enter}')

      await waitFor(() => expect(searchAudiobooks).toHaveBeenCalledTimes(1))
      expect(searchAudiobooks).toHaveBeenCalledWith('lib1', 'dune', { signal: expect.any(AbortSignal) })
      // Submitting drops focus, which trims the box, so what the user sees is what was sent.
      await waitFor(() => expect(box).toHaveValue('dune'))
    })

    it('sends the same query for "dune" and " dune " (one value, not two)', async () => {
      const user = userEvent.setup()
      const searchAudiobooks = vi.fn().mockResolvedValue(emptyResponse)
      renderDiscover(clientWith(searchAudiobooks))

      const box = screen.getByLabelText('Search audiobooks')
      await user.type(box, 'dune{Enter}')
      await waitFor(() => expect(searchAudiobooks).toHaveBeenCalledTimes(1))
      await user.clear(box)
      await user.type(box, ' dune {Enter}')
      await waitFor(() => expect(searchAudiobooks).toHaveBeenCalledTimes(2))

      expect(searchAudiobooks.mock.calls.map((call) => call[1])).toEqual(['dune', 'dune'])
    })

    it('does not fire a request for a whitespace-only query, by button or by Enter', async () => {
      const user = userEvent.setup()
      const searchAudiobooks = vi.fn().mockResolvedValue(emptyResponse)
      renderDiscover(clientWith(searchAudiobooks))

      const box = screen.getByLabelText('Search audiobooks')
      await user.type(box, '    {Enter}')

      expect(screen.getByRole('button', { name: 'Search' })).toBeDisabled()
      expect(searchAudiobooks).not.toHaveBeenCalled()
    })
  })

  it('explains before any search that acquiring is server-side and offline listening needs a device download', async () => {
    renderDiscover({ searchAudiobooks: vi.fn(), createAcquisition: vi.fn(), listAcquisitions: vi.fn().mockResolvedValue([]), status: vi.fn().mockResolvedValue(null) })

    // Awaited rather than read synchronously: the page now also resolves the Browse capability
    // check on mount, and a synchronous assertion would finish the test while that setState was
    // still pending -- which React reports as an update outside act().
    const explainer = await screen.findByTestId('discover-explainer')
    expect(explainer).toHaveTextContent(/server/i)
    expect(explainer).toHaveTextContent(/download it to your device/i)
    expect(explainer).toHaveTextContent(/offline/i)
  })

  it('states both steps (server-side acquisition, then device download) in the confirm dialog', async () => {
    const user = userEvent.setup()
    const searchAudiobooks = vi.fn().mockResolvedValue({
      searchSessionId: 'search-1',
      results: [release({ releaseId: 'rel-1', title: 'Project Hail Mary' })]
    } satisfies SearchResponse)

    renderDiscover({ searchAudiobooks, createAcquisition: vi.fn(), listAcquisitions: vi.fn().mockResolvedValue([]), status: vi.fn().mockResolvedValue(null) })

    await user.type(screen.getByLabelText('Search audiobooks'), 'Project Hail Mary')
    await user.click(screen.getByRole('button', { name: 'Search' }))
    await user.click(await screen.findByRole('button', { name: 'Acquire' }))

    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Acquire "Project Hail Mary"?')).toBeInTheDocument()
    const description = within(dialog).getByTestId('confirm-dialog-description')
    expect(description).toHaveTextContent(/Step 1:.*server.*Nothing is saved to this phone/s)
    expect(description).toHaveTextContent(/Step 2:.*download it to your device.*offline/s)
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
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
