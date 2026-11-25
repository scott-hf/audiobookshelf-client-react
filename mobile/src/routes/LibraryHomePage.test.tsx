import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { AbsClient } from '../api/absClient'
import { AuthContext, type AuthContextValue } from '../auth/AuthProvider'
import { UserProgressProvider } from '../progress/UserProgressProvider'
import { withClientDefaults } from '../test/absClientMock'
import type { AbsAuthor, AbsLibraryItem, AbsSeries, AbsShelf } from '../types/abs'
import LibraryHomePage from './LibraryHomePage'

function book(id: string, title: string): AbsLibraryItem {
  return { id, libraryId: 'lib', media: { metadata: { title, authorName: 'Some Author' } } }
}

function shelf(id: string, label: string, type: string, entities: unknown[]): AbsShelf {
  return { id, label, labelStringKey: `Label${id}`, type, entities, total: entities.length }
}

function renderHome(client: Partial<AbsClient>) {
  const authValue: AuthContextValue = {
    state: { status: 'authenticated', serverUrl: 'https://books.test' },
    client: withClientDefaults(client),
    acquisitionClient: null,
    login: vi.fn(),
    logout: vi.fn()
  }
  return render(
    <AuthContext.Provider value={authValue}>
      <UserProgressProvider>
        <MemoryRouter initialEntries={['/library/lib']}>
          <Routes>
            <Route path="/library/:libraryId" element={<LibraryHomePage />} />
            <Route path="/library/:libraryId/books" element={<p>all books page</p>} />
            <Route path="/library/:libraryId/discover" element={<p>discover page</p>} />
            <Route path="/library/:libraryId/item/:itemId" element={<p>item page</p>} />
          </Routes>
        </MemoryRouter>
      </UserProgressProvider>
    </AuthContext.Provider>
  )
}

/** Shelf headings in on-screen order. */
function headings(): string[] {
  return screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent ?? '')
}

describe('LibraryHomePage', () => {
  it('renders book, series and author shelves by type and shows server labels', async () => {
    const series: AbsSeries = { id: 's1', name: 'The Expanse', books: [book('e1', 'Leviathan Wakes'), book('e2', 'Ales Gate')] }
    const author: AbsAuthor = { id: 'a1', name: 'Andy Weir', numBooks: 3, imagePath: '/metadata/authors/a1.jpg' }
    const getLibraryPersonalized = vi.fn().mockResolvedValue([
      shelf('recently-added', 'Recently Added', 'book', [book('b1', 'Project Hail Mary')]),
      shelf('recent-series', 'Recent Series', 'series', [series]),
      shelf('newest-authors', 'Newest Authors', 'authors', [author])
    ])
    renderHome({ getLibraryPersonalized })

    expect(await screen.findByRole('heading', { name: 'Recently Added' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Recent Series' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Newest Authors' })).toBeInTheDocument()
    expect(screen.getByText('Project Hail Mary')).toBeInTheDocument()
    expect(screen.getByText('The Expanse')).toBeInTheDocument()
    expect(screen.getByText('2 in series')).toBeInTheDocument()
    expect(screen.getByText('Andy Weir')).toBeInTheDocument()
    expect(screen.getByText('3 in library')).toBeInTheDocument()
    expect(getLibraryPersonalized).toHaveBeenCalledWith('lib', undefined, expect.any(AbortSignal))
  })

  it('renders by type rather than id: an unfamiliar id with a book type still shows', async () => {
    const getLibraryPersonalized = vi.fn().mockResolvedValue([shelf('made-up-shelf-2031', 'Fresh Idea', 'book', [book('b1', 'Some Book')])])
    renderHome({ getLibraryPersonalized })
    expect(await screen.findByRole('heading', { name: 'Fresh Idea' })).toBeInTheDocument()
    expect(screen.getByText('Some Book')).toBeInTheDocument()
  })

  it('skips shelves of unknown type and shelves with no entities', async () => {
    const getLibraryPersonalized = vi.fn().mockResolvedValue([
      shelf('newest-episodes', 'Newest Episodes', 'episode', [{ id: 'ep1' }]),
      shelf('mystery', 'Mystery Shelf', 'brand-new-type', [{ id: 'x' }]),
      shelf('empty-books', 'Empty Books', 'book', []),
      { ...shelf('malformed', 'Malformed', 'book', []), entities: undefined },
      shelf('recently-added', 'Recently Added', 'book', [book('b1', 'Kept')])
    ])
    renderHome({ getLibraryPersonalized })

    expect(await screen.findByRole('heading', { name: 'Recently Added' })).toBeInTheDocument()
    expect(headings()).toEqual(['Recently Added'])
  })

  it('puts listening-history shelves before the rest, keeping server order otherwise', async () => {
    const getLibraryPersonalized = vi.fn().mockResolvedValue([
      shelf('recently-added', 'Recently Added', 'book', [book('b1', 'A')]),
      shelf('discover', 'Discover', 'book', [book('b2', 'B')]),
      shelf('listen-again', 'Listen Again', 'book', [book('b3', 'C')]),
      shelf('continue-series', 'Continue Series', 'book', [book('b4', 'D')]),
      shelf('continue-listening', 'Continue Listening', 'book', [book('b5', 'E')])
    ])
    renderHome({ getLibraryPersonalized })

    await screen.findByRole('heading', { name: 'Continue Listening' })
    expect(headings()).toEqual(['Continue Listening', 'Continue Series', 'Listen Again', 'Recently Added', 'Discover'])
  })

  it('draws progress bars from the user progress map on book shelves', async () => {
    const getLibraryPersonalized = vi.fn().mockResolvedValue([
      shelf('continue-listening', 'Continue Listening', 'book', [book('b1', 'Half Done'), book('b2', 'All Done'), book('b3', 'Untouched')])
    ])
    const getMe = vi.fn().mockResolvedValue({
      id: 'user-1',
      username: 'tester',
      mediaProgress: [
        { id: 'mp1', libraryItemId: 'b1', episodeId: null, progress: 0.5, currentTime: 50, duration: 100, isFinished: false },
        { id: 'mp2', libraryItemId: 'b2', episodeId: null, progress: 1, currentTime: 100, duration: 100, isFinished: true }
      ]
    })
    renderHome({ getLibraryPersonalized, getMe })

    const half = (await screen.findByText('Half Done')).closest('button') as HTMLElement
    expect(await within(half).findByRole('progressbar')).toHaveAttribute('aria-valuenow', '50')
    expect(within(screen.getByText('All Done').closest('button') as HTMLElement).getByLabelText('Finished')).toBeInTheDocument()
    expect(within(screen.getByText('Untouched').closest('button') as HTMLElement).queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it('opens a book from a rail', async () => {
    const user = userEvent.setup()
    const getLibraryPersonalized = vi.fn().mockResolvedValue([shelf('recently-added', 'Recently Added', 'book', [book('b1', 'Tap Me')])])
    renderHome({ getLibraryPersonalized })
    await user.click(await screen.findByText('Tap Me'))
    expect(await screen.findByText('item page')).toBeInTheDocument()
  })

  it('links to the full book list and to Discover', async () => {
    const user = userEvent.setup()
    const getLibraryPersonalized = vi.fn().mockResolvedValue([shelf('recently-added', 'Recently Added', 'book', [book('b1', 'A')])])
    renderHome({ getLibraryPersonalized })

    await user.click(await screen.findByRole('link', { name: /All books/ }))
    expect(await screen.findByText('all books page')).toBeInTheDocument()
  })

  it('shows loading skeletons while the shelves load', async () => {
    const getLibraryPersonalized = vi.fn().mockReturnValue(new Promise(() => {}))
    renderHome({ getLibraryPersonalized })
    expect(await screen.findByRole('status', { name: 'Loading your library…' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    // Navigation is available immediately, not gated on the shelves.
    expect(screen.getByRole('link', { name: /All books/ })).toBeInTheDocument()
  })

  it('shows an empty state with a way to the full list when no shelf has entities', async () => {
    const getLibraryPersonalized = vi.fn().mockResolvedValue([shelf('recently-added', 'Recently Added', 'book', []), shelf('x', 'X', 'authors', [])])
    renderHome({ getLibraryPersonalized })

    expect(await screen.findByText('Nothing to show here yet.')).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: /All books/ }).length).toBeGreaterThanOrEqual(2)
  })

  it('shows an error that does not block navigation, and retries', async () => {
    const user = userEvent.setup()
    const getLibraryPersonalized = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue([shelf('recently-added', 'Recently Added', 'book', [book('b1', 'Back Online')])])
    renderHome({ getLibraryPersonalized })

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Could not load your shelves.')
    expect(screen.getByRole('link', { name: /Discover/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /All books/ })).toBeInTheDocument()
    expect(screen.queryByText('Nothing to show here yet.')).not.toBeInTheDocument()

    await user.click(within(alert).getByRole('button', { name: 'Retry' }))

    expect(await screen.findByText('Back Online')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(getLibraryPersonalized).toHaveBeenCalledTimes(2)
  })

  it('keeps the shelves on screen when a manual refresh fails', async () => {
    const user = userEvent.setup()
    const getLibraryPersonalized = vi
      .fn()
      .mockResolvedValueOnce([shelf('recently-added', 'Recently Added', 'book', [book('b1', 'Still Here')])])
      .mockRejectedValueOnce(new Error('offline'))
    renderHome({ getLibraryPersonalized })

    await screen.findByText('Still Here')
    await user.click(screen.getByRole('button', { name: 'Refresh' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load your shelves.')
    expect(screen.getByText('Still Here')).toBeInTheDocument()
  })

  it('refreshes the shelves from the refresh button', async () => {
    const user = userEvent.setup()
    const getLibraryPersonalized = vi
      .fn()
      .mockResolvedValueOnce([shelf('recently-added', 'Recently Added', 'book', [book('b1', 'Old Book')])])
      .mockResolvedValue([shelf('recently-added', 'Recently Added', 'book', [book('b2', 'New Book')])])
    renderHome({ getLibraryPersonalized })

    await screen.findByText('Old Book')
    await user.click(screen.getByRole('button', { name: 'Refresh' }))

    expect(await screen.findByText('New Book')).toBeInTheDocument()
    expect(screen.queryByText('Old Book')).not.toBeInTheDocument()
  })
})
