import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { AbsClient } from '../api/absClient'
import { AuthContext, type AuthContextValue } from '../auth/AuthProvider'
import { withClientDefaults } from '../test/absClientMock'
import { DownloadContext, DownloadProvider, type DownloadContextValue } from '../downloads/DownloadProvider'
import { authorFilter, genreFilter, narratorFilter, parseFilter, progressFilter, seriesFilter } from '../lib/filterUtils'
import { UserProgressProvider } from '../progress/UserProgressProvider'
import type { AbsFilterData, AbsLibrary, AbsLibraryItem } from '../types/abs'
import BookDetailsPage from './BookDetailsPage'
import LibrariesPage from './LibrariesPage'
import LibraryPage from './LibraryPage'

vi.mock('../native/absDownloaderPlugin', () => ({
  default: {
    enqueue: vi.fn().mockResolvedValue({ id: 'download-1' }),
    pause: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    listQueue: vi.fn().mockResolvedValue({ items: [] }),
    addListener: vi.fn().mockResolvedValue({ remove: () => Promise.resolve() })
  }
}))

vi.mock('../native/absFileSystemPlugin', () => ({
  default: {
    listLocalItems: vi.fn().mockResolvedValue({ items: [] }),
    chooseDownloadFolder: vi.fn().mockResolvedValue(null),
    deleteLocalItem: vi.fn().mockResolvedValue(undefined)
  }
}))

function library(overrides: Partial<AbsLibrary> & { id: string }): AbsLibrary {
  return { name: 'Library', mediaType: 'book', ...overrides }
}

function book(overrides: Partial<AbsLibraryItem> & { id: string; title: string }): AbsLibraryItem {
  const { title, ...rest } = overrides
  return { libraryId: 'books', media: { metadata: { title, authorName: 'Author' } }, ...rest }
}

/** Exposes the router's current query string and a back button, so URL state can be asserted. */
function RouterProbe() {
  const location = useLocation()
  const navigate = useNavigate()
  return (
    <>
      <output data-testid="location-search">{location.search}</output>
      <button type="button" onClick={() => navigate(-1)}>
        test-back
      </button>
    </>
  )
}

function renderMobile(initialPath: string, client: Partial<AbsClient>, downloads?: Partial<DownloadContextValue>) {
  const authValue: AuthContextValue = {
    state: { status: 'authenticated', serverUrl: 'https://books.test' },
    client: withClientDefaults(client),
    acquisitionClient: null,
    login: vi.fn(),
    logout: vi.fn()
  }
  // A real DownloadProvider is inert off-device (no local items); tests of the Downloaded filter
  // inject a context value instead.
  const DownloadsWrapper = downloads
    ? ({ children }: { children: ReactNode }) => (
        <DownloadContext.Provider
          value={{ queue: [], localItems: [], isLocal: () => false, download: vi.fn(), pause: vi.fn(), resume: vi.fn(), cancel: vi.fn(), remove: vi.fn(), ...downloads }}
        >
          {children}
        </DownloadContext.Provider>
      )
    : DownloadProvider
  return render(
    <AuthContext.Provider value={authValue}>
      <UserProgressProvider>
        <DownloadsWrapper>
          <MemoryRouter initialEntries={[initialPath]}>
            <RouterProbe />
            <Routes>
              <Route path="/libraries" element={<LibrariesPage />} />
              <Route path="/library/:libraryId/books" element={<LibraryPage />} />
              <Route path="/library/:libraryId/item/:itemId" element={<BookDetailsPage />} />
            </Routes>
          </MemoryRouter>
        </DownloadsWrapper>
      </UserProgressProvider>
    </AuthContext.Provider>
  )
}

describe('LibrariesPage', () => {
  // Two book libraries, because a SINGLE one is now auto-selected and never listed (see
  // LibrariesPage.test.tsx). The point of this test is the podcast filter, so it needs a list
  // that actually renders.
  it('shows only book libraries', async () => {
    const getLibraries = vi.fn().mockResolvedValue({
      libraries: [
        library({ id: 'books', name: 'Books', mediaType: 'book' }),
        library({ id: 'more-books', name: 'More Books', mediaType: 'book' }),
        library({ id: 'podcasts', name: 'Podcasts', mediaType: 'podcast' })
      ]
    })
    renderMobile('/libraries', { getLibraries })

    expect(await screen.findByText('Books')).toBeInTheDocument()
    expect(screen.getByText('More Books')).toBeInTheDocument()
    expect(screen.queryByText('Podcasts')).not.toBeInTheDocument()
  })
})

describe('LibraryPage', () => {
  it('shows only book libraries and opens item details', async () => {
    const user = userEvent.setup()
    const getLibraryItems = vi.fn().mockResolvedValue({ results: [book({ id: 'b1', title: 'Project Hail Mary' })], total: 1 })
    const getLibraryItem = vi.fn().mockResolvedValue(book({ id: 'b1', title: 'Project Hail Mary' }))
    renderMobile('/library/books/books', { getLibraryItems, getLibraryItem })

    const title = await screen.findByText('Project Hail Mary')
    await user.click(title)

    expect(await screen.findByRole('heading', { name: 'Project Hail Mary' })).toBeInTheDocument()
    expect(getLibraryItem).toHaveBeenCalledWith('b1')
  })

  it('shows an empty state when the library has no books', async () => {
    const getLibraryItems = vi.fn().mockResolvedValue({ results: [], total: 0 })
    renderMobile('/library/books/books', { getLibraryItems })
    expect(await screen.findByText('No books in this library yet.')).toBeInTheDocument()
  })

  it('loads further pages with "Load more" until total is reached', async () => {
    const user = userEvent.setup()
    const getLibraryItems = vi.fn().mockImplementation((_libraryId: string, options: { page?: number }) =>
      Promise.resolve(
        options.page === 0
          ? { results: [book({ id: 'b1', title: 'First Book' }), book({ id: 'b2', title: 'Second Book' })], total: 3, limit: 2, page: 0 }
          : { results: [book({ id: 'b3', title: 'Third Book' })], total: 3, limit: 2, page: 1 }
      )
    )
    renderMobile('/library/books/books', { getLibraryItems })

    expect(await screen.findByText('First Book')).toBeInTheDocument()
    expect(screen.getByText('2 of 3 books')).toBeInTheDocument()
    expect(screen.queryByText('Third Book')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Load more' }))

    expect(await screen.findByText('Third Book')).toBeInTheDocument()
    expect(screen.getByText('First Book')).toBeInTheDocument()
    expect(screen.getByText('3 of 3 books')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
    expect(getLibraryItems).toHaveBeenCalledTimes(2)
    expect(getLibraryItems.mock.calls[1][1]).toMatchObject({ page: 1 })
  })

  it('keeps loaded books and retries when a later page fails', async () => {
    const user = userEvent.setup()
    const firstPage = Array.from({ length: 48 }, (_, i) => book({ id: `p${i}`, title: `Book ${i}` }))
    let failNext = true
    const getLibraryItems = vi.fn().mockImplementation((_libraryId: string, options: { page?: number }) => {
      if (options.page === 0) return Promise.resolve({ results: firstPage, total: 49 })
      if (failNext) {
        failNext = false
        return Promise.reject(new Error('offline'))
      }
      return Promise.resolve({ results: [book({ id: 'last', title: 'Last Book' })], total: 49 })
    })
    renderMobile('/library/books/books', { getLibraryItems })

    expect(await screen.findByText('Book 0')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Load more' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load more books')
    expect(screen.getByText('Book 0')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Load more' }))
    expect(await screen.findByText('Last Book')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('draws progress bars from the user progress map, not from the item', async () => {
    const getLibraryItems = vi.fn().mockResolvedValue({
      results: [book({ id: 'b1', title: 'Half Done' }), book({ id: 'b2', title: 'All Done' }), book({ id: 'b3', title: 'Untouched' })],
      total: 3
    })
    const getMe = vi.fn().mockResolvedValue({
      id: 'user-1',
      username: 'tester',
      mediaProgress: [
        { id: 'mp1', libraryItemId: 'b1', episodeId: null, progress: 0.5, currentTime: 50, duration: 100, isFinished: false },
        { id: 'mp2', libraryItemId: 'b2', episodeId: null, progress: 1, currentTime: 100, duration: 100, isFinished: true }
      ]
    })
    renderMobile('/library/books/books', { getLibraryItems, getMe })

    const half = (await screen.findByText('Half Done')).closest('button') as HTMLElement
    expect(await within(half).findByRole('progressbar')).toHaveAttribute('aria-valuenow', '50')
    const done = screen.getByText('All Done').closest('button') as HTMLElement
    expect(within(done).getByLabelText('Finished')).toBeInTheDocument()
    expect(within(screen.getByText('Untouched').closest('button') as HTMLElement).queryByRole('progressbar')).not.toBeInTheDocument()
  })
})

const FILTER_DATA: AbsFilterData = {
  authors: [
    { id: 'au_1', name: 'Andy Weir' },
    { id: 'au_2', name: 'James S. A. Corey' }
  ],
  // Verbatim shapes from a real 2.35.1 library: comma-joined multi-genre, near-duplicates.
  genres: ['Action & Adventure', 'Adventure', 'Adventure, Space Opera, Military', 'Audiobook', 'Audiobooks'],
  tags: [],
  series: [
    { id: 'se_1', name: 'Expanse' },
    { id: 'se_2', name: 'The Expanse' }
  ],
  narrators: ['Wil Wheaton', 'R. C. Bray'],
  languages: ['eng', 'English'],
  publishers: [],
  publishedDecades: ['2010', '2020']
}

/** Options of the most recent `getLibraryItems(libraryId, options)` call. */
const lastOptions = (getLibraryItems: ReturnType<typeof vi.fn>) => getLibraryItems.mock.calls.at(-1)?.[1] as Record<string, unknown>

const openSheet = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: /Filter & sort/ }))
  await screen.findByRole('dialog')
}

/** A list endpoint that answers per filter, so a test can tell which query produced what is on screen. */
function filteringListMock() {
  return vi.fn().mockImplementation((_libraryId: string, options: { page?: number; filter?: string }) => {
    if (options.filter) return Promise.resolve({ results: [book({ id: 'f1', title: 'Filtered Book' })], total: 1 })
    return Promise.resolve(
      options.page === 0
        ? { results: [book({ id: 'b1', title: 'First Book' }), book({ id: 'b2', title: 'Second Book' })], total: 3 }
        : { results: [book({ id: 'b3', title: 'Third Book' })], total: 3 }
    )
  })
}

describe('LibraryPage filter sheet', () => {
  it('fetches filter options only when the sheet opens, and hides groups with no options', async () => {
    const user = userEvent.setup()
    const getFilterData = vi.fn().mockResolvedValue(FILTER_DATA)
    renderMobile('/library/books/books', { getLibraryItems: filteringListMock(), getFilterData })

    await screen.findByText('First Book')
    expect(getFilterData).not.toHaveBeenCalled()

    await openSheet(user)
    expect(await screen.findByRole('button', { name: 'Genre' })).toBeInTheDocument()
    expect(getFilterData).toHaveBeenCalledWith('books', expect.anything())
    for (const name of ['Author', 'Series', 'Narrator', 'Progress', 'Language', 'Published Decade']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument()
    }
    // `tags` and `publishers` came back empty in the real library: no dead menus for them.
    expect(screen.queryByRole('button', { name: 'Tags' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Publisher' })).not.toBeInTheDocument()
  })

  it('still offers Progress, and a retry, when filter options fail to load', async () => {
    const user = userEvent.setup()
    const getFilterData = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(FILTER_DATA)
    renderMobile('/library/books/books', { getLibraryItems: filteringListMock(), getFilterData })

    await screen.findByText('First Book')
    await openSheet(user)
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load filter options')
    expect(screen.getByRole('button', { name: 'Progress' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Genre' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('button', { name: 'Genre' })).toBeInTheDocument()
  })

  it('applies a genre verbatim, goes back to page 0, and shows a chip', async () => {
    const user = userEvent.setup()
    const getLibraryItems = filteringListMock()
    renderMobile('/library/books/books', { getLibraryItems, getFilterData: vi.fn().mockResolvedValue(FILTER_DATA) })

    await screen.findByText('First Book')
    await user.click(screen.getByRole('button', { name: 'Load more' }))
    expect(await screen.findByText('Third Book')).toBeInTheDocument()

    await openSheet(user)
    await user.click(await screen.findByRole('button', { name: 'Genre' }))
    // The comma-joined genre is ONE server key; it must not be split or tidied.
    await user.click(screen.getByRole('button', { name: 'Adventure, Space Opera, Military' }))

    expect(await screen.findByText('Filtered Book')).toBeInTheDocument()
    expect(screen.queryByText('Third Book')).not.toBeInTheDocument()
    expect(lastOptions(getLibraryItems)).toMatchObject({ page: 0, filter: genreFilter('Adventure, Space Opera, Military') })
    expect(screen.getByText('Genre: Adventure, Space Opera, Military')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // Persisted in the URL exactly as the server wants it.
    expect(new URLSearchParams(screen.getByTestId('location-search').textContent ?? '').get('filter')).toBe(genreFilter('Adventure, Space Opera, Military'))
  })

  it.each([
    ['Author', 'Andy Weir', authorFilter('au_1'), 'au_1', 'Author: Andy Weir'],
    // `Expanse` and `The Expanse` are separate server entities; each keeps its own id.
    ['Series', 'The Expanse', seriesFilter('se_2'), 'se_2', 'Series: The Expanse'],
    ['Narrator', 'R. C. Bray', narratorFilter('R. C. Bray'), 'R. C. Bray', 'Narrator: R. C. Bray'],
    ['Progress', 'In Progress', progressFilter('in-progress'), 'in-progress', 'Progress: In Progress']
  ])('filters %s %s by the right key (ids for author/series, names otherwise)', async (group, optionLabel, expectedFilter, expectedValue, chip) => {
    const user = userEvent.setup()
    const getLibraryItems = filteringListMock()
    renderMobile('/library/books/books', { getLibraryItems, getFilterData: vi.fn().mockResolvedValue(FILTER_DATA) })

    await screen.findByText('First Book')
    await openSheet(user)
    await user.click(await screen.findByRole('button', { name: group }))
    await user.click(screen.getByRole('button', { name: optionLabel }))

    expect(await screen.findByText('Filtered Book')).toBeInTheDocument()
    const filter = lastOptions(getLibraryItems).filter as string
    expect(filter).toBe(expectedFilter)
    expect(parseFilter(filter)?.value).toBe(expectedValue)
    expect(screen.getByText(chip)).toBeInTheDocument()
  })

  it('changes the query when the sort or direction changes', async () => {
    const user = userEvent.setup()
    const getLibraryItems = filteringListMock()
    renderMobile('/library/books/books', { getLibraryItems, getFilterData: vi.fn().mockResolvedValue(FILTER_DATA) })

    await screen.findByText('First Book')
    expect(lastOptions(getLibraryItems)).toMatchObject({ sort: 'media.metadata.title', desc: false, page: 0 })

    await openSheet(user)
    await user.selectOptions(screen.getByLabelText('Sort by'), 'Added At')
    await waitFor(() => expect(lastOptions(getLibraryItems)).toMatchObject({ sort: 'addedAt', desc: true, page: 0 }))

    await user.click(screen.getByRole('button', { name: 'Ascending' }))
    await waitFor(() => expect(lastOptions(getLibraryItems)).toMatchObject({ sort: 'addedAt', desc: false, page: 0 }))
    const search = new URLSearchParams(screen.getByTestId('location-search').textContent ?? '')
    expect(search.get('sort')).toBe('addedAt')
  })

  it('clears the filter in one tap and returns to an unfiltered page 0', async () => {
    const user = userEvent.setup()
    const getLibraryItems = filteringListMock()
    renderMobile(`/library/books/books?filter=${encodeURIComponent(genreFilter('Adventure'))}`, { getLibraryItems, getFilterData: vi.fn().mockResolvedValue(FILTER_DATA) })

    expect(await screen.findByText('Filtered Book')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Clear filter: Genre: Adventure' }))

    expect(await screen.findByText('First Book')).toBeInTheDocument()
    expect(screen.queryByText('Genre: Adventure')).not.toBeInTheDocument()
    expect(lastOptions(getLibraryItems)).toMatchObject({ page: 0 })
    expect(lastOptions(getLibraryItems).filter).toBeUndefined()
    expect(screen.getByTestId('location-search')).toBeEmptyDOMElement()
  })

  it('reads filter and sort from the URL, and keeps them across opening a book and going back', async () => {
    const user = userEvent.setup()
    const getLibraryItems = filteringListMock()
    const getLibraryItem = vi.fn().mockResolvedValue(book({ id: 'f1', title: 'Filtered Book' }))
    const filter = genreFilter('Action & Adventure')
    renderMobile(`/library/books/books?filter=${encodeURIComponent(filter)}&sort=addedAt&desc=1`, { getLibraryItems, getLibraryItem })

    expect(await screen.findByText('Filtered Book')).toBeInTheDocument()
    expect(getLibraryItems.mock.calls[0][1]).toMatchObject({ filter, sort: 'addedAt', desc: true })

    await user.click(screen.getByText('Filtered Book'))
    expect(await screen.findByRole('heading', { name: 'Filtered Book' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'test-back' }))

    expect(await screen.findByText('Genre: Action & Adventure')).toBeInTheDocument()
    expect(lastOptions(getLibraryItems)).toMatchObject({ filter, sort: 'addedAt', desc: true, page: 0 })
  })

  it('ignores a filter in the URL that the server could not parse', async () => {
    const getLibraryItems = filteringListMock()
    renderMobile('/library/books/books?filter=garbage&sort=random', { getLibraryItems })

    expect(await screen.findByText('First Book')).toBeInTheDocument()
    expect(lastOptions(getLibraryItems).filter).toBeUndefined()
    expect(lastOptions(getLibraryItems).sort).toBe('media.metadata.title')
  })

  it('names an author chip from /filterdata when the link carried no label', async () => {
    const getFilterData = vi.fn().mockResolvedValue(FILTER_DATA)
    renderMobile(`/library/books/books?filter=${encodeURIComponent(authorFilter('au_1'))}`, { getLibraryItems: filteringListMock(), getFilterData })

    expect(await screen.findByText('Author: Andy Weir')).toBeInTheDocument()
    expect(getFilterData).toHaveBeenCalled()
  })

  it('explains an empty filtered result differently from an empty library', async () => {
    const getLibraryItems = vi.fn().mockResolvedValue({ results: [], total: 0 })
    renderMobile(`/library/books/books?filter=${encodeURIComponent(genreFilter('Nothing'))}`, { getLibraryItems, getFilterData: vi.fn().mockResolvedValue(FILTER_DATA) })
    expect(await screen.findByText('No books match this filter.')).toBeInTheDocument()
  })
})

describe('LibraryPage Downloaded filter', () => {
  it('loads every page, then shows only books saved on this device', async () => {
    const user = userEvent.setup()
    const getLibraryItems = filteringListMock()
    renderMobile('/library/books/books', { getLibraryItems, getFilterData: vi.fn().mockResolvedValue(FILTER_DATA) }, { isLocal: (id) => id === 'b2' })

    await screen.findByText('First Book')
    expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument()

    await openSheet(user)
    await user.click(screen.getByRole('switch', { name: 'Downloaded to this device only' }))
    await user.click(screen.getByRole('button', { name: 'Close' }))

    // Page 1 is fetched without a tap, because the narrowing is only correct over the full list.
    expect(await screen.findByText('1 downloaded of 3 books')).toBeInTheDocument()
    expect(getLibraryItems).toHaveBeenCalledTimes(2)
    expect(getLibraryItems.mock.calls[1][1]).toMatchObject({ page: 1 })
    expect(screen.getByText('Second Book')).toBeInTheDocument()
    expect(screen.queryByText('First Book')).not.toBeInTheDocument()
    expect(screen.queryByText('Third Book')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
    // It is not a server filter, so nothing about it may reach the request.
    expect(lastOptions(getLibraryItems).filter).toBeUndefined()
    expect(JSON.stringify(lastOptions(getLibraryItems))).not.toContain('downloaded')
  })

  it('combines with a server filter and can be cleared from its chip', async () => {
    const user = userEvent.setup()
    const getLibraryItems = filteringListMock()
    renderMobile(`/library/books/books?downloaded=1&filter=${encodeURIComponent(genreFilter('Adventure'))}`, { getLibraryItems }, { isLocal: (id) => id === 'f1' })

    expect(await screen.findByText('Filtered Book')).toBeInTheDocument()
    expect(lastOptions(getLibraryItems).filter).toBe(genreFilter('Adventure'))

    await user.click(screen.getByRole('button', { name: 'Clear filter: Downloaded' }))
    // Only the Downloaded narrowing goes; the independent server filter stays.
    expect(screen.queryByRole('button', { name: 'Clear filter: Downloaded' })).not.toBeInTheDocument()
    expect(screen.getByText('Genre: Adventure')).toBeInTheDocument()
    expect(new URLSearchParams(screen.getByTestId('location-search').textContent ?? '').has('downloaded')).toBe(false)
  })

  it('says so when nothing on this device matches', async () => {
    const getLibraryItems = filteringListMock()
    renderMobile('/library/books/books?downloaded=1', { getLibraryItems }, { isLocal: () => false })
    expect(await screen.findByText('No downloaded books match.')).toBeInTheDocument()
  })

  it('stops auto-loading and offers a retry when a page fails', async () => {
    const user = userEvent.setup()
    let failNext = true
    const getLibraryItems = vi.fn().mockImplementation((_libraryId: string, options: { page?: number }) => {
      if (options.page === 0) return Promise.resolve({ results: [book({ id: 'b1', title: 'First Book' })], total: 2 })
      if (failNext) {
        failNext = false
        return Promise.reject(new Error('offline'))
      }
      return Promise.resolve({ results: [book({ id: 'b2', title: 'Second Book' })], total: 2 })
    })
    renderMobile('/library/books/books?downloaded=1', { getLibraryItems }, { isLocal: () => true })

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load more books')
    // One failed attempt, not a retry loop.
    expect(getLibraryItems).toHaveBeenCalledTimes(2)
    await user.click(screen.getByRole('button', { name: 'Load more' }))
    expect(await screen.findByText('Second Book')).toBeInTheDocument()
  })
})

describe('BookDetailsPage metadata links', () => {
  const expanded = book({
    id: 'b1',
    title: 'Leviathan Wakes',
    media: {
      metadata: {
        title: 'Leviathan Wakes',
        authorName: 'James S. A. Corey',
        authors: [{ id: 'au_2', name: 'James S. A. Corey' }],
        series: [{ id: 'se_2', name: 'The Expanse', sequence: '1' }],
        narrators: ['Jefferson Mays'],
        genres: ['Adventure, Space Opera, Military', 'Audiobook']
      }
    }
  })

  it.each([
    ['genre', 'Adventure, Space Opera, Military', genreFilter('Adventure, Space Opera, Military'), 'Genre: Adventure, Space Opera, Military'],
    ['author', 'James S. A. Corey', authorFilter('au_2'), 'Author: James S. A. Corey'],
    ['series', 'The Expanse', seriesFilter('se_2'), 'Series: The Expanse'],
    ['narrator', 'Jefferson Mays', narratorFilter('Jefferson Mays'), 'Narrator: Jefferson Mays']
  ])('tapping a %s opens the library list filtered by it', async (_kind, linkText, expectedFilter, chip) => {
    const user = userEvent.setup()
    const getLibraryItem = vi.fn().mockResolvedValue(expanded)
    const getLibraryItems = filteringListMock()
    renderMobile('/library/books/item/b1', { getLibraryItem, getLibraryItems })

    await user.click(await screen.findByRole('link', { name: linkText }))

    expect(await screen.findByText('Filtered Book')).toBeInTheDocument()
    expect(lastOptions(getLibraryItems)).toMatchObject({ filter: expectedFilter, page: 0 })
    expect(screen.getByText(chip)).toBeInTheDocument()
  })

  it('leaves author and narrator as plain text when the item has no structured lists', async () => {
    const plain = book({ id: 'b1', title: 'Plain Book', media: { metadata: { title: 'Plain Book', authorName: 'Some Author', narratorName: 'Some Narrator' } } })
    renderMobile('/library/books/item/b1', { getLibraryItem: vi.fn().mockResolvedValue(plain) })

    expect(await screen.findByText('Some Author')).toBeInTheDocument()
    expect(screen.getByText('Some Narrator')).toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })
})
