import type { DiscoverBrowseResponse, DiscoverItem, DiscoverOptionsResponse } from '@abs/acquisition-contract'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { AbsClient } from '../api/absClient'
import type { MobileAcquisitionClient } from '../api/acquisitionClient'
import { AuthContext, type AuthContextValue } from '../auth/AuthProvider'
import { AcquisitionProvider } from '../contexts/AcquisitionContext'
import { UserProgressProvider } from '../progress/UserProgressProvider'
import { withClientDefaults } from '../test/absClientMock'
import type { AbsLibraryItem, AbsUserMediaProgress } from '../types/abs'
import DiscoverPage from './DiscoverPage'

/**
 * Integration tests for the Discover page's Browse tab, driven through the real page, panel, cards
 * and hooks. Only the two network clients are faked.
 *
 * Every test builds a FRESH acquisition client: `useDiscoverOptions` caches its settled answer per
 * client instance and `useLibraryIndex` keys its cache on it too, so sharing one would leak state
 * between tests.
 */

type BrowseFn = MobileAcquisitionClient['browseDiscover']
type OptionsFn = MobileAcquisitionClient['getDiscoverOptions']

const OPTIONS: DiscoverOptionsResponse = {
  catalogs: [
    { id: 'popular', label: 'Popular' },
    { id: 'new', label: 'New' },
    { id: 'top_rated', label: 'Top rated' }
  ],
  genres: [
    { id: 'fantasy', label: 'Fantasy' },
    { id: 'science fiction', label: 'Science fiction' },
    { id: 'historical fiction', label: 'Historical fiction' }
  ]
}

// Real strings from en-us.json, so a reworded message fails here rather than passing silently.
const TEXT = {
  empty: 'No books found for this selection. Try another genre.',
  invalid: 'This list is no longer offered. Pick another.',
  unavailable: 'Open Library is temporarily unavailable. Search still works.',
  failed: "Couldn't load suggestions. Check your connection and try again.",
  rateLimited: 'Too many requests to Open Library. Try again in a minute.',
  partial: 'Open Library could not rank these, so the order is not meaningful.',
  loadMoreFailed: 'Could not load more books. Tap to retry.',
  forYouEmpty: 'Listen to a few books and suggestions based on your genres will show up here.',
  forYouNoMatches: 'No suggestions came back for the genres you have been listening to. Try a catalog instead.',
  browsePopular: 'Browse popular books',
  owned: 'In server library'
}

const ATOMIC_HABITS: DiscoverItem = {
  key: '/works/OL17930368W',
  title: 'Atomic Habits',
  author: 'James Clear',
  coverUrl: 'https://covers.openlibrary.org/b/id/12539702-M.jpg',
  year: 2016,
  popularity: 66698
}

function suggestion(n: number): DiscoverItem {
  return { key: `/works/OL${n}W`, title: `Suggestion ${n}`, author: `Writer ${n}`, coverUrl: `https://covers.openlibrary.org/b/id/${n}-M.jpg`, year: 2000 + n, popularity: null }
}

function suggestions(from: number, count: number): DiscoverItem[] {
  return Array.from({ length: count }, (_, i) => suggestion(from + i))
}

function page(items: DiscoverItem[], overrides: Partial<DiscoverBrowseResponse> = {}): DiscoverBrowseResponse {
  return { status: 'ok', catalog: 'popular', genre: '', offset: 0, nextOffset: null, partial: false, items, ...overrides }
}

/** A thrown gateway failure: the client surfaces the gateway's error code on `.code`. */
function gatewayError(code: string): Error {
  return Object.assign(new Error(code), { code })
}

function libraryBook(id: string, title: string, authorName: string | undefined, genres: string[] = []): AbsLibraryItem {
  return { id, libraryId: 'lib1', media: { metadata: { title, authorName, genres }, duration: 36000 } } as AbsLibraryItem
}

function progressRow(libraryItemId: string, overrides: Partial<AbsUserMediaProgress> = {}): AbsUserMediaProgress {
  return {
    id: `mp_${libraryItemId}`,
    libraryItemId,
    episodeId: null,
    mediaItemType: 'book',
    currentTime: 20000,
    duration: 36000,
    progress: 0.55,
    isFinished: false,
    // Epoch MILLISECONDS, as the real server sends it.
    lastUpdate: Date.now(),
    ...overrides
  } as AbsUserMediaProgress
}

/** A fresh acquisition client with every method the Discover page touches. */
function makeAcquisition(overrides: Partial<MobileAcquisitionClient> = {}): Partial<MobileAcquisitionClient> {
  return {
    status: vi.fn().mockResolvedValue(null),
    listAcquisitions: vi.fn().mockResolvedValue([]),
    searchAudiobooks: vi.fn().mockResolvedValue({ searchSessionId: 'search-1', results: [] }),
    getDiscoverOptions: vi.fn<OptionsFn>().mockResolvedValue(OPTIONS),
    browseDiscover: vi.fn<BrowseFn>().mockResolvedValue(page([])),
    ...overrides
  }
}

/** The client of a gateway that predates discover: the method is absent, not failing. */
function makeAcquisitionWithoutDiscover(): Partial<MobileAcquisitionClient> {
  const client = makeAcquisition()
  delete client.getDiscoverOptions
  delete client.browseDiscover
  return client
}

/** The ABS client: owned books for the index, and `/api/me` progress for For you. */
function makeAbs(library: AbsLibraryItem[] = [], mediaProgress: AbsUserMediaProgress[] = []): Partial<AbsClient> {
  return {
    getLibraryItems: vi.fn().mockResolvedValue({ results: library, total: library.length }),
    getMe: vi.fn().mockResolvedValue({ id: 'user-1', username: 'tester', mediaProgress })
  }
}

function RouterProbe() {
  const location = useLocation()
  return (
    <>
      <output data-testid="location-path">{location.pathname}</output>
      <output data-testid="location-search">{location.search}</output>
    </>
  )
}

interface RenderOptions {
  path?: string
  acquisition?: Partial<MobileAcquisitionClient>
  abs?: Partial<AbsClient>
}

function renderDiscover({ path = '/library/lib1/discover', acquisition = makeAcquisition(), abs = makeAbs() }: RenderOptions = {}) {
  const authValue: AuthContextValue = {
    state: { status: 'authenticated', serverUrl: 'https://books.test' },
    client: withClientDefaults(abs),
    acquisitionClient: acquisition as MobileAcquisitionClient,
    login: vi.fn(),
    logout: vi.fn()
  }
  return render(
    <AuthContext.Provider value={authValue}>
      <UserProgressProvider>
        <AcquisitionProvider>
          <MemoryRouter initialEntries={[path]}>
            <RouterProbe />
            <Routes>
              <Route path="/library/:libraryId/discover" element={<DiscoverPage />} />
              <Route path="/library/:libraryId/item/:itemId" element={<div>Book details page</div>} />
            </Routes>
          </MemoryRouter>
        </AcquisitionProvider>
      </UserProgressProvider>
    </AuthContext.Provider>
  )
}

const BROWSE_PATH = '/library/lib1/discover?mode=browse'

function urlParams(): URLSearchParams {
  return new URLSearchParams(screen.getByTestId('location-search').textContent ?? '')
}

function currentPath(): string {
  return screen.getByTestId('location-path').textContent ?? ''
}

/** The request params of every `browseDiscover` call, in order. */
function requested(browseDiscover: ReturnType<typeof vi.fn<BrowseFn>>) {
  return browseDiscover.mock.calls.map((call) => call[0])
}

function cards() {
  return screen.queryAllByRole('button', { name: /Find a copy to acquire|Open in your library/ })
}

describe('Discover tabs', () => {
  it('lands on Search by default and never calls browseDiscover', async () => {
    const browseDiscover = vi.fn<BrowseFn>().mockResolvedValue(page([ATOMIC_HABITS]))
    const getDiscoverOptions = vi.fn<OptionsFn>().mockResolvedValue(OPTIONS)
    renderDiscover({ acquisition: makeAcquisition({ browseDiscover, getDiscoverOptions }) })

    expect(screen.getByLabelText('Search audiobooks')).toBeInTheDocument()
    // Wait for the options to settle: a Browse fetch, if it were going to happen, would follow.
    await waitFor(() => expect(getDiscoverOptions).toHaveBeenCalledTimes(1))
    expect(await screen.findByRole('tab', { name: 'Search', selected: true })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Browse', selected: false })).toBeInTheDocument()
    expect(screen.queryByLabelText('Open Library catalog')).not.toBeInTheDocument()
    expect(browseDiscover).not.toHaveBeenCalled()
    expect(urlParams().get('mode')).toBeNull()
  })

  it('shows both selects on Browse and requests Popular with no genre', async () => {
    const user = userEvent.setup()
    const browseDiscover = vi.fn<BrowseFn>().mockResolvedValue(page([ATOMIC_HABITS]))
    renderDiscover({ acquisition: makeAcquisition({ browseDiscover }) })

    await user.click(await screen.findByRole('tab', { name: 'Browse' }))

    const catalog = await screen.findByLabelText('Open Library catalog')
    const genre = screen.getByLabelText('Genre')
    expect(catalog).toHaveValue('popular')
    expect(genre).toHaveValue('__all__')
    // Catalogs from the server, then the client-only For you entry.
    expect(within(catalog).getAllByRole('option').map((o) => o.textContent)).toEqual(['Popular', 'New', 'Top rated', 'For you'])
    expect(within(genre).getAllByRole('option').map((o) => o.textContent)).toEqual(['All genres', 'Fantasy', 'Science fiction', 'Historical fiction'])

    await waitFor(() => expect(browseDiscover).toHaveBeenCalledTimes(1))
    expect(browseDiscover).toHaveBeenCalledWith({ catalog: 'popular', offset: 0 }, { signal: expect.any(AbortSignal) })
    expect(requested(browseDiscover)[0]).not.toHaveProperty('genre')
    expect(screen.getByRole('tab', { name: 'Browse', selected: true })).toBeInTheDocument()
    expect(urlParams().get('mode')).toBe('browse')
    expect(await screen.findByText('Atomic Habits')).toBeInTheDocument()
  })

  // Regression: the Search field used to keep its text in local state only, and switching to
  // Browse unmounts the panel, so a typed query was lost on the round trip. The draft now lives
  // in `DiscoverPage` -- not in the URL, because writing a history entry per keystroke to
  // preserve it would be worse than losing it.
  it('preserves a typed query when switching to Browse and back to Search', async () => {
    const user = userEvent.setup()
    renderDiscover()

    await user.type(screen.getByLabelText('Search audiobooks'), 'dune')
    await user.click(await screen.findByRole('tab', { name: 'Browse' }))
    await screen.findByLabelText('Open Library catalog')
    await user.click(screen.getByRole('tab', { name: 'Search' }))

    expect(await screen.findByLabelText('Search audiobooks')).toHaveValue('dune')
  })

  it('preserves a query that is already in the URL across Browse and back', async () => {
    const user = userEvent.setup()
    renderDiscover({ path: '/library/lib1/discover?q=dune' })

    expect(screen.getByLabelText('Search audiobooks')).toHaveValue('dune')
    await user.click(await screen.findByRole('tab', { name: 'Browse' }))
    await screen.findByLabelText('Open Library catalog')
    expect(urlParams().get('q')).toBe('dune')
    expect(urlParams().get('mode')).toBe('browse')

    await user.click(screen.getByRole('tab', { name: 'Search' }))
    expect(await screen.findByLabelText('Search audiobooks')).toHaveValue('dune')
    expect(urlParams().get('mode')).toBeNull()
  })

  it('renders no tablist at all, and Search alone, when the client has no getDiscoverOptions', async () => {
    renderDiscover({ acquisition: makeAcquisitionWithoutDiscover() })

    await waitFor(() => expect(screen.queryByRole('tablist')).not.toBeInTheDocument())
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Search audiobooks')).toBeInTheDocument()
    expect(screen.queryByLabelText('Open Library catalog')).not.toBeInTheDocument()
  })

  it('falls back to Search from a ?mode=browse link when the gateway has no discover', async () => {
    renderDiscover({ path: BROWSE_PATH, acquisition: makeAcquisitionWithoutDiscover() })

    expect(await screen.findByLabelText('Search audiobooks')).toBeInTheDocument()
    await waitFor(() => expect(urlParams().get('mode')).toBeNull())
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Open Library catalog')).not.toBeInTheDocument()
  })

  it('hides the tab when the gateway answers discover_not_supported', async () => {
    const getDiscoverOptions = vi.fn<OptionsFn>().mockRejectedValue(gatewayError('discover_not_supported'))
    renderDiscover({ acquisition: makeAcquisition({ getDiscoverOptions }) })

    await waitFor(() => expect(screen.queryByRole('tablist')).not.toBeInTheDocument())
    expect(screen.getByLabelText('Search audiobooks')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('reports an options failure with a Retry that refetches, and does not hide the tab', async () => {
    const user = userEvent.setup()
    const getDiscoverOptions = vi.fn<OptionsFn>().mockRejectedValueOnce(gatewayError('discover_upstream_unavailable')).mockResolvedValue(OPTIONS)
    const browseDiscover = vi.fn<BrowseFn>().mockResolvedValue(page([ATOMIC_HABITS]))
    renderDiscover({ path: BROWSE_PATH, acquisition: makeAcquisition({ getDiscoverOptions, browseDiscover }) })

    // Changed from TEXT.unavailable: the page does not receive the options fetch's error code (it
    // is `null` by the time it reaches the panel), and without a code we cannot know Open Library
    // is the culprit -- so this is the generic wording, whatever the underlying code was.
    expect(await screen.findByRole('alert')).toHaveTextContent(TEXT.failed)
    expect(screen.getByRole('tablist')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Browse', selected: true })).toBeInTheDocument()
    expect(getDiscoverOptions).toHaveBeenCalledTimes(1)
    expect(browseDiscover).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByLabelText('Open Library catalog')).toBeInTheDocument()
    expect(getDiscoverOptions).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(await screen.findByText('Atomic Habits')).toBeInTheDocument()
  })
})

describe('Browse catalogs', () => {
  it('requests the chosen catalog and reflects it in the URL', async () => {
    const user = userEvent.setup()
    const browseDiscover = vi.fn<BrowseFn>().mockResolvedValue(page([ATOMIC_HABITS]))
    renderDiscover({ path: BROWSE_PATH, acquisition: makeAcquisition({ browseDiscover }) })

    const catalog = await screen.findByLabelText('Open Library catalog')
    await waitFor(() => expect(browseDiscover).toHaveBeenCalledTimes(1))

    await user.selectOptions(catalog, 'Top rated')

    await waitFor(() => expect(browseDiscover).toHaveBeenCalledTimes(2))
    expect(requested(browseDiscover)[1]).toEqual({ catalog: 'top_rated', offset: 0 })
    expect(requested(browseDiscover)[1]).not.toHaveProperty('genre')
    expect(screen.getByLabelText('Open Library catalog')).toHaveValue('top_rated')
    expect(urlParams().get('mode')).toBe('browse')
    expect(urlParams().get('catalog')).toBe('top_rated')
  })

  it('sends a genre id verbatim, including one containing a space', async () => {
    const user = userEvent.setup()
    const browseDiscover = vi.fn<BrowseFn>().mockResolvedValue(page([ATOMIC_HABITS]))
    renderDiscover({ path: BROWSE_PATH, acquisition: makeAcquisition({ browseDiscover }) })

    await user.selectOptions(await screen.findByLabelText('Genre'), 'science fiction')

    await waitFor(() => expect(browseDiscover).toHaveBeenCalledTimes(2))
    const params = requested(browseDiscover)[1]
    expect(params).toEqual({ catalog: 'popular', genre: 'science fiction', offset: 0 })
    expect(params?.genre).toBe('science fiction')
    expect(urlParams().get('genre')).toBe('science fiction')
    expect(screen.getByLabelText('Genre')).toHaveValue('science fiction')
  })

  it('keeps the genre when the catalog changes', async () => {
    const user = userEvent.setup()
    const browseDiscover = vi.fn<BrowseFn>().mockResolvedValue(page([ATOMIC_HABITS]))
    renderDiscover({ path: BROWSE_PATH, acquisition: makeAcquisition({ browseDiscover }) })

    await user.selectOptions(await screen.findByLabelText('Genre'), 'historical fiction')
    await waitFor(() => expect(browseDiscover).toHaveBeenCalledTimes(2))
    await user.selectOptions(screen.getByLabelText('Open Library catalog'), 'New')

    await waitFor(() => expect(browseDiscover).toHaveBeenCalledTimes(3))
    expect(requested(browseDiscover)[2]).toEqual({ catalog: 'new', genre: 'historical fiction', offset: 0 })
  })

  it('sends no genre key at all after selecting All genres', async () => {
    const user = userEvent.setup()
    const browseDiscover = vi.fn<BrowseFn>().mockResolvedValue(page([ATOMIC_HABITS]))
    renderDiscover({ path: BROWSE_PATH, acquisition: makeAcquisition({ browseDiscover }) })

    await user.selectOptions(await screen.findByLabelText('Genre'), 'fantasy')
    await waitFor(() => expect(browseDiscover).toHaveBeenCalledTimes(2))
    expect(requested(browseDiscover)[1]?.genre).toBe('fantasy')

    await user.selectOptions(screen.getByLabelText('Genre'), 'All genres')

    await waitFor(() => expect(browseDiscover).toHaveBeenCalledTimes(3))
    const params = requested(browseDiscover)[2]
    expect(params).toEqual({ catalog: 'popular', offset: 0 })
    expect(params).not.toHaveProperty('genre')
    // The sentinel never reaches the server and never reaches the URL.
    expect(JSON.stringify(requested(browseDiscover))).not.toContain('__all__')
    expect(urlParams().has('genre')).toBe(false)
    expect(urlParams().has('genreLabel')).toBe(false)
  })

  // A controlled <select> with no matching <option> displays its FIRST option while the state --
  // and the request -- say otherwise: the user reads "All genres" and is served Biography.
  it('synthesises an option, labelled from the selection, for a genre that is not in the options', async () => {
    const browseDiscover = vi.fn<BrowseFn>().mockResolvedValue(page([ATOMIC_HABITS]))
    renderDiscover({ path: `${BROWSE_PATH}&genre=Biography&genreLabel=Life+stories`, acquisition: makeAcquisition({ browseDiscover }) })

    const genre = await screen.findByLabelText('Genre')
    await waitFor(() => expect(browseDiscover).toHaveBeenCalledTimes(1))
    expect(requested(browseDiscover)[0]).toEqual({ catalog: 'popular', genre: 'Biography', offset: 0 })
    // The display matches the request.
    expect(genre).toHaveValue('Biography')
    expect(within(genre).getAllByRole('option').map((o) => o.textContent)).toEqual(['All genres', 'Fantasy', 'Science fiction', 'Historical fiction', 'Life stories'])
  })

  it('falls back to the raw genre id for the synthesised option when the selection has no label', async () => {
    const browseDiscover = vi.fn<BrowseFn>().mockResolvedValue(page([ATOMIC_HABITS]))
    renderDiscover({ path: `${BROWSE_PATH}&genre=Biography`, acquisition: makeAcquisition({ browseDiscover }) })

    const genre = await screen.findByLabelText('Genre')
    expect(genre).toHaveValue('Biography')
    expect(within(genre).getAllByRole('option').map((o) => o.textContent)).toEqual(['All genres', 'Fantasy', 'Science fiction', 'Historical fiction', 'Biography'])
  })

  it('adds no extra option for a genre the options do list, nor for the All genres sentinel', async () => {
    renderDiscover({ path: `${BROWSE_PATH}&genre=fantasy`, acquisition: makeAcquisition({ browseDiscover: vi.fn<BrowseFn>().mockResolvedValue(page([ATOMIC_HABITS])) }) })

    const genre = await screen.findByLabelText('Genre')
    expect(genre).toHaveValue('fantasy')
    expect(within(genre).getAllByRole('option')).toHaveLength(4)
    expect(within(screen.getByLabelText('Open Library catalog')).getAllByRole('option')).toHaveLength(4)
  })

  it('synthesises a catalog option when the pinned catalog is not among the server catalogs', async () => {
    const getDiscoverOptions = vi.fn<OptionsFn>().mockResolvedValue({
      catalogs: [
        { id: 'new', label: 'New' },
        { id: 'top_rated', label: 'Top rated' }
      ],
      genres: OPTIONS.genres
    })
    const browseDiscover = vi.fn<BrowseFn>().mockResolvedValue(page([ATOMIC_HABITS]))
    renderDiscover({ path: BROWSE_PATH, acquisition: makeAcquisition({ getDiscoverOptions, browseDiscover }) })

    const catalog = await screen.findByLabelText('Open Library catalog')
    await waitFor(() => expect(browseDiscover).toHaveBeenCalledTimes(1))
    // Popular is what is being requested, so Popular is what the picker must say.
    expect(requested(browseDiscover)[0]).toEqual({ catalog: 'popular', offset: 0 })
    expect(catalog).toHaveValue('popular')
    expect(within(catalog).getAllByRole('option').map((o) => o.textContent)).toEqual(['New', 'Top rated', 'Popular', 'For you'])
  })

  it('describes the popularity metric as reading-log adds, not readers', async () => {
    renderDiscover({ path: BROWSE_PATH, acquisition: makeAcquisition({ browseDiscover: vi.fn<BrowseFn>().mockResolvedValue(page([ATOMIC_HABITS])) }) })

    await screen.findByText('Atomic Habits')
    expect(screen.getByText(/reading-log adds/)).toHaveTextContent('Book suggestions come from Open Library, not from your server.')
    expect(document.body.textContent).not.toContain('Open Library readers')
  })

  it('renders title and author, and never shows the popularity number', async () => {
    renderDiscover({ path: BROWSE_PATH, acquisition: makeAcquisition({ browseDiscover: vi.fn<BrowseFn>().mockResolvedValue(page([ATOMIC_HABITS])) }) })

    expect(await screen.findByText('Atomic Habits')).toBeInTheDocument()
    expect(screen.getByText('James Clear')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Atomic Habits by James Clear. Find a copy to acquire' })).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('66698')
    expect(document.body.textContent).not.toContain('66,698')
    expect(document.body.innerHTML).not.toContain('66698')
  })

  it('"Load more" requests the server nextOffset (not a page index) and appends', async () => {
    const user = userEvent.setup()
    const browseDiscover = vi
      .fn<BrowseFn>()
      .mockResolvedValueOnce(page(suggestions(1, 20), { nextOffset: 20 }))
      .mockResolvedValueOnce(page(suggestions(21, 20), { offset: 20, nextOffset: null }))
    renderDiscover({ path: BROWSE_PATH, acquisition: makeAcquisition({ browseDiscover }) })

    await screen.findByText('Suggestion 1')
    expect(cards()).toHaveLength(20)

    await user.click(screen.getByRole('button', { name: 'Load more' }))

    expect(await screen.findByText('Suggestion 40')).toBeInTheDocument()
    expect(browseDiscover).toHaveBeenCalledTimes(2)
    expect(requested(browseDiscover)[1]).toEqual({ catalog: 'popular', offset: 20 })
    // Appended after the first page, not replacing it.
    expect(screen.getByText('Suggestion 1')).toBeInTheDocument()
    expect(cards()).toHaveLength(40)
    // `nextOffset: null` is the end of paging.
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
  })

  // The single most important paging case: a real `science fiction` page came back with 7 items and
  // the cursor still advancing (Open Library drops works that fail the catalog's filter). Inferring
  // "last page" from items.length < 20 would strand the user with 7 books.
  it('still offers Load more on a SHORT page whose cursor is non-null', async () => {
    const user = userEvent.setup()
    const browseDiscover = vi
      .fn<BrowseFn>()
      .mockResolvedValueOnce(page(suggestions(1, 7), { genre: 'science fiction', nextOffset: 20 }))
      .mockResolvedValueOnce(page(suggestions(8, 20), { genre: 'science fiction', offset: 20, nextOffset: null }))
    renderDiscover({ path: `${BROWSE_PATH}&genre=science+fiction`, acquisition: makeAcquisition({ browseDiscover }) })

    await screen.findByText('Suggestion 1')
    expect(cards()).toHaveLength(7)
    const loadMore = screen.getByRole('button', { name: 'Load more' })
    expect(loadMore).toBeInTheDocument()

    await user.click(loadMore)

    expect(await screen.findByText('Suggestion 27')).toBeInTheDocument()
    expect(requested(browseDiscover)[1]).toEqual({ catalog: 'popular', genre: 'science fiction', offset: 20 })
    expect(cards()).toHaveLength(27)
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
  })

  it('stops offering Load more only when the cursor is null, even on a full page', async () => {
    renderDiscover({ path: BROWSE_PATH, acquisition: makeAcquisition({ browseDiscover: vi.fn<BrowseFn>().mockResolvedValue(page(suggestions(1, 20), { nextOffset: null })) }) })

    await screen.findByText('Suggestion 1')
    expect(cards()).toHaveLength(20)
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
  })

  it('keeps the loaded cards when a later page fails, names a rate limit, and retries at the same cursor', async () => {
    const user = userEvent.setup()
    const browseDiscover = vi
      .fn<BrowseFn>()
      .mockResolvedValueOnce(page(suggestions(1, 20), { nextOffset: 20 }))
      .mockRejectedValueOnce(gatewayError('discover_rate_limited'))
      .mockResolvedValueOnce(page(suggestions(21, 3), { offset: 20, nextOffset: null }))
    renderDiscover({ path: BROWSE_PATH, acquisition: makeAcquisition({ browseDiscover }) })

    await screen.findByText('Suggestion 1')
    await user.click(screen.getByRole('button', { name: 'Load more' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(TEXT.rateLimited)
    expect(cards()).toHaveLength(20)

    await user.click(screen.getByRole('button', { name: 'Load more' }))

    expect(await screen.findByText('Suggestion 23')).toBeInTheDocument()
    expect(requested(browseDiscover).map((p) => p.offset)).toEqual([0, 20, 20])
    expect(cards()).toHaveLength(23)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  // Regression: `CatalogBody` used to treat `items.length === 0` as the end of the shelf, which
  // stranded the user whenever Open Library filtered a whole page away while the cursor was
  // still advancing. Only the hook's own `empty` ends paging -- a page's size says nothing about
  // whether the cursor is exhausted.
  it('offers Load more on a BLANK page whose cursor is non-null', async () => {
    const browseDiscover = vi
      .fn<BrowseFn>()
      .mockResolvedValueOnce(page([], { nextOffset: 20 }))
      .mockResolvedValueOnce(page(suggestions(1, 5), { offset: 20, nextOffset: null }))
    renderDiscover({ path: BROWSE_PATH, acquisition: makeAcquisition({ browseDiscover }) })

    expect(await screen.findByRole('button', { name: 'Load more' })).toBeInTheDocument()
  })
})

describe('Browse outcomes', () => {
  it('shows the empty message for status "empty", distinct from the failure message', async () => {
    renderDiscover({ path: BROWSE_PATH, acquisition: makeAcquisition({ browseDiscover: vi.fn<BrowseFn>().mockResolvedValue(page([], { status: 'empty' })) }) })

    expect(await screen.findByText(TEXT.empty)).toBeInTheDocument()
    expect(screen.queryByText(TEXT.unavailable)).not.toBeInTheDocument()
    expect(screen.queryByText(TEXT.invalid)).not.toBeInTheDocument()
    // An empty shelf is not a failure: no alert and nothing to retry.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
  })

  it('shows "no longer offered" for invalid_request, distinct from empty and error', async () => {
    renderDiscover({ path: BROWSE_PATH, acquisition: makeAcquisition({ browseDiscover: vi.fn<BrowseFn>().mockResolvedValue(page([], { status: 'invalid_request' })) }) })

    expect(await screen.findByText(TEXT.invalid)).toBeInTheDocument()
    expect(screen.queryByText(TEXT.empty)).not.toBeInTheDocument()
    expect(screen.queryByText(TEXT.unavailable)).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows the unavailable alert for discover_upstream_unavailable, and Retry refetches', async () => {
    const user = userEvent.setup()
    const browseDiscover = vi.fn<BrowseFn>().mockRejectedValueOnce(gatewayError('discover_upstream_unavailable')).mockResolvedValue(page([ATOMIC_HABITS]))
    renderDiscover({ path: BROWSE_PATH, acquisition: makeAcquisition({ browseDiscover }) })

    expect(await screen.findByRole('alert')).toHaveTextContent(TEXT.unavailable)
    // A failure is not an empty shelf.
    expect(screen.queryByText(TEXT.empty)).not.toBeInTheDocument()
    expect(browseDiscover).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByText('Atomic Habits')).toBeInTheDocument()
    expect(browseDiscover).toHaveBeenCalledTimes(2)
    // The retry is the same request, not a different selection.
    expect(requested(browseDiscover)[1]).toEqual(requested(browseDiscover)[0])
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('uses the rate-limit wording, not the generic unavailable wording, for discover_rate_limited', async () => {
    const browseDiscover = vi.fn<BrowseFn>().mockRejectedValue(gatewayError('discover_rate_limited'))
    renderDiscover({ path: BROWSE_PATH, acquisition: makeAcquisition({ browseDiscover }) })

    expect(await screen.findByRole('alert')).toHaveTextContent(TEXT.rateLimited)
    expect(screen.queryByText(TEXT.unavailable)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  // Only `discover_upstream_unavailable` actually means Open Library is down. Every other failure
  // may be the network, the gateway or Librarr, and naming Open Library (or promising Search still
  // works, when the shared gateway is what failed) would be a guess dressed as a finding.
  it.each(['librarr_timeout', 'librarr_unreachable', 'discover_bad_response', 'librarr_error'])(
    'uses the generic failure wording, not the Open Library wording, for %s',
    async (code) => {
      const browseDiscover = vi.fn<BrowseFn>().mockRejectedValue(gatewayError(code))
      renderDiscover({ path: BROWSE_PATH, acquisition: makeAcquisition({ browseDiscover }) })

      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent(TEXT.failed)
      expect(alert).not.toHaveTextContent('Open Library')
      expect(alert).not.toHaveTextContent('Search still works')
      expect(screen.queryByText(TEXT.unavailable)).not.toBeInTheDocument()
      expect(screen.queryByText(TEXT.rateLimited)).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    }
  )

  it('uses the generic failure wording for a failure with no code at all (a dropped connection)', async () => {
    const browseDiscover = vi.fn<BrowseFn>().mockRejectedValue(new TypeError('Failed to fetch'))
    renderDiscover({ path: BROWSE_PATH, acquisition: makeAcquisition({ browseDiscover }) })

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(TEXT.failed)
    expect(alert).not.toHaveTextContent('Open Library')
  })

  it('uses the generic failure wording when the OPTIONS fetch fails with a non-Open-Library code', async () => {
    const getDiscoverOptions = vi.fn<OptionsFn>().mockRejectedValue(gatewayError('librarr_timeout'))
    renderDiscover({ path: BROWSE_PATH, acquisition: makeAcquisition({ getDiscoverOptions }) })

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(TEXT.failed)
    expect(alert).not.toHaveTextContent('Open Library')
    expect(screen.getByRole('tab', { name: 'Browse', selected: true })).toBeInTheDocument()
  })

  it('shows the Open Library wording only for discover_upstream_unavailable', async () => {
    const browseDiscover = vi.fn<BrowseFn>().mockRejectedValue(gatewayError('discover_upstream_unavailable'))
    renderDiscover({ path: BROWSE_PATH, acquisition: makeAcquisition({ browseDiscover }) })

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(TEXT.unavailable)
    expect(alert).not.toHaveTextContent(TEXT.failed)
  })

  it('maps a failed later page through the same code-to-copy table: generic, Open Library, then rate limit', async () => {
    const user = userEvent.setup()
    const browseDiscover = vi
      .fn<BrowseFn>()
      .mockResolvedValueOnce(page(suggestions(1, 20), { nextOffset: 20 }))
      .mockRejectedValueOnce(gatewayError('librarr_timeout'))
      .mockRejectedValueOnce(gatewayError('discover_upstream_unavailable'))
      .mockRejectedValueOnce(gatewayError('discover_rate_limited'))
    renderDiscover({ path: BROWSE_PATH, acquisition: makeAcquisition({ browseDiscover }) })

    await screen.findByText('Suggestion 1')
    await user.click(screen.getByRole('button', { name: 'Load more' }))

    // A timeout has the existing, already non-accusing "could not load more" copy.
    expect(await screen.findByRole('alert')).toHaveTextContent(TEXT.loadMoreFailed)
    expect(screen.getByRole('alert')).not.toHaveTextContent('Open Library')

    await user.click(screen.getByRole('button', { name: 'Load more' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(TEXT.unavailable))

    await user.click(screen.getByRole('button', { name: 'Load more' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(TEXT.rateLimited))
    expect(cards()).toHaveLength(20)
  })

  // A later page the server no longer accepts clears the cursor, so `hasMore` goes false. The
  // failure notice used to live inside the `hasMore` block and would have vanished with the
  // button, leaving the shelf ending with no explanation.
  it('still shows the failure notice when a later page is invalid and the cursor has been cleared', async () => {
    const user = userEvent.setup()
    const browseDiscover = vi
      .fn<BrowseFn>()
      .mockResolvedValueOnce(page(suggestions(1, 20), { nextOffset: 20 }))
      // Not a thrown error: the catalog ANSWERS the follow-up page `invalid_request`, and the hook
      // turns that into the synthetic `discover_invalid_selection` code and drops the cursor.
      .mockResolvedValueOnce(page([], { status: 'invalid_request', offset: 20 }))
    renderDiscover({ path: BROWSE_PATH, acquisition: makeAcquisition({ browseDiscover }) })

    await screen.findByText('Suggestion 1')
    await user.click(screen.getByRole('button', { name: 'Load more' }))

    // The "no longer offered" wording, not a retry prompt: retrying cannot help.
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(TEXT.invalid)
    expect(alert).not.toHaveTextContent(TEXT.loadMoreFailed)
    // No cursor, so no button -- and the cards already on screen stay.
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
    expect(cards()).toHaveLength(20)
    expect(browseDiscover).toHaveBeenCalledTimes(2)
  })

  it('shows the "order is not meaningful" notice when the page is partial', async () => {
    renderDiscover({ path: BROWSE_PATH, acquisition: makeAcquisition({ browseDiscover: vi.fn<BrowseFn>().mockResolvedValue(page([ATOMIC_HABITS], { partial: true })) }) })

    expect(await screen.findByText(TEXT.partial)).toBeInTheDocument()
    expect(screen.getByText('Atomic Habits')).toBeInTheDocument()
  })

  it('does not show the partial notice for an ordinary page', async () => {
    renderDiscover({ path: BROWSE_PATH, acquisition: makeAcquisition({ browseDiscover: vi.fn<BrowseFn>().mockResolvedValue(page([ATOMIC_HABITS])) }) })

    expect(await screen.findByText('Atomic Habits')).toBeInTheDocument()
    expect(screen.queryByText(TEXT.partial)).not.toBeInTheDocument()
  })
})

describe('Browse and owned books', () => {
  it('badges a suggestion that matches a library book, and opens that book', async () => {
    const user = userEvent.setup()
    const abs = makeAbs([libraryBook('item-42', 'Atomic Habits', 'James Clear'), libraryBook('item-7', 'Dune', 'Frank Herbert')])
    renderDiscover({ path: BROWSE_PATH, abs, acquisition: makeAcquisition({ browseDiscover: vi.fn<BrowseFn>().mockResolvedValue(page([ATOMIC_HABITS])) }) })

    expect(await screen.findByText(TEXT.owned)).toBeInTheDocument()
    expect(abs.getLibraryItems).toHaveBeenCalledWith('lib1', expect.objectContaining({ minified: true }))

    await user.click(screen.getByRole('button', { name: 'Atomic Habits by James Clear. Open in your library' }))

    await waitFor(() => expect(currentPath()).toBe('/library/lib1/item/item-42'))
    expect(await screen.findByText('Book details page')).toBeInTheDocument()
  })

  it('hands an unmatched suggestion to Search, seeded "<title> <author>", and runs it', async () => {
    const user = userEvent.setup()
    const abs = makeAbs([libraryBook('item-7', 'Dune', 'Frank Herbert')])
    const searchAudiobooks = vi.fn().mockResolvedValue({ searchSessionId: 'search-1', results: [] })
    renderDiscover({ path: BROWSE_PATH, abs, acquisition: makeAcquisition({ searchAudiobooks, browseDiscover: vi.fn<BrowseFn>().mockResolvedValue(page([ATOMIC_HABITS])) }) })

    const card = await screen.findByRole('button', { name: 'Atomic Habits by James Clear. Find a copy to acquire' })
    await waitFor(() => expect(abs.getLibraryItems).toHaveBeenCalled())
    expect(screen.queryByText(TEXT.owned)).not.toBeInTheDocument()

    await user.click(card)

    await waitFor(() => expect(searchAudiobooks).toHaveBeenCalledTimes(1))
    expect(searchAudiobooks).toHaveBeenCalledWith('lib1', 'Atomic Habits James Clear', { signal: expect.any(AbortSignal) })
    expect(screen.getByRole('tab', { name: 'Search', selected: true })).toBeInTheDocument()
    expect(screen.getByLabelText('Search audiobooks')).toHaveValue('Atomic Habits James Clear')
    expect(urlParams().get('q')).toBe('Atomic Habits James Clear')
    expect(urlParams().get('mode')).toBeNull()
    expect(currentPath()).toBe('/library/lib1/discover')
  })

  it('does not re-run the handed-over search when returning to the Search tab later', async () => {
    const user = userEvent.setup()
    const searchAudiobooks = vi.fn().mockResolvedValue({ searchSessionId: 'search-1', results: [] })
    renderDiscover({ path: BROWSE_PATH, acquisition: makeAcquisition({ searchAudiobooks, browseDiscover: vi.fn<BrowseFn>().mockResolvedValue(page([ATOMIC_HABITS])) }) })

    await user.click(await screen.findByRole('button', { name: 'Atomic Habits by James Clear. Find a copy to acquire' }))
    await waitFor(() => expect(searchAudiobooks).toHaveBeenCalledTimes(1))

    await user.click(screen.getByRole('tab', { name: 'Browse' }))
    await screen.findByLabelText('Open Library catalog')
    await user.click(screen.getByRole('tab', { name: 'Search' }))
    await screen.findByLabelText('Search audiobooks')

    expect(searchAudiobooks).toHaveBeenCalledTimes(1)
  })

  it('treats a title match with a blank library author as ambiguous: no badge, and it searches instead of navigating', async () => {
    const user = userEvent.setup()
    const abs = makeAbs([libraryBook('item-42', 'Atomic Habits', undefined)])
    const searchAudiobooks = vi.fn().mockResolvedValue({ searchSessionId: 'search-1', results: [] })
    renderDiscover({ path: BROWSE_PATH, abs, acquisition: makeAcquisition({ searchAudiobooks, browseDiscover: vi.fn<BrowseFn>().mockResolvedValue(page([ATOMIC_HABITS])) }) })

    const card = await screen.findByRole('button', { name: 'Atomic Habits by James Clear. Find a copy to acquire' })
    await waitFor(() => expect(abs.getLibraryItems).toHaveBeenCalled())
    expect(screen.queryByText(TEXT.owned)).not.toBeInTheDocument()

    await user.click(card)

    await waitFor(() => expect(searchAudiobooks).toHaveBeenCalledTimes(1))
    expect(currentPath()).toBe('/library/lib1/discover')
  })

  it('still shows suggestions, without badges, when the library index fails to load', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const abs: Partial<AbsClient> = { ...makeAbs(), getLibraryItems: vi.fn().mockRejectedValue(new Error('offline')) }
    renderDiscover({ path: BROWSE_PATH, abs, acquisition: makeAcquisition({ browseDiscover: vi.fn<BrowseFn>().mockResolvedValue(page([ATOMIC_HABITS])) }) })

    expect(await screen.findByText('Atomic Habits')).toBeInTheDocument()
    await waitFor(() => expect(warn).toHaveBeenCalled())
    expect(screen.queryByText(TEXT.owned)).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    warn.mockRestore()
  })
})

describe('Browse: For you', () => {
  it('shows the For-you empty message and a Browse-popular button when there is no listening history', async () => {
    const user = userEvent.setup()
    const browseDiscover = vi.fn<BrowseFn>().mockResolvedValue(page([ATOMIC_HABITS]))
    renderDiscover({ path: BROWSE_PATH, acquisition: makeAcquisition({ browseDiscover }) })

    await screen.findByText('Atomic Habits')
    expect(browseDiscover).toHaveBeenCalledTimes(1)

    await user.selectOptions(screen.getByLabelText('Open Library catalog'), 'For you')

    expect(await screen.findByText(TEXT.forYouEmpty)).toBeInTheDocument()
    expect(urlParams().get('catalog')).toBe('for_you')
    // Not the failure message, and no request: there are no genres to ask about.
    expect(screen.queryByText(TEXT.unavailable)).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(browseDiscover).toHaveBeenCalledTimes(1)
    // The genre picker reads "All genres" while For you is selected.
    expect(screen.getByLabelText('Genre')).toHaveValue('__all__')

    await user.click(screen.getByRole('button', { name: TEXT.browsePopular }))

    await waitFor(() => expect(browseDiscover).toHaveBeenCalledTimes(2))
    expect(requested(browseDiscover)[1]).toEqual({ catalog: 'popular', offset: 0 })
    expect(screen.getByLabelText('Open Library catalog')).toHaveValue('popular')
    expect(urlParams().has('catalog')).toBe(false)
    expect(urlParams().get('mode')).toBe('browse')
    expect(screen.queryByText(TEXT.forYouEmpty)).not.toBeInTheDocument()
    expect(await screen.findByText('Atomic Habits')).toBeInTheDocument()
  })

  it('renders one "Popular in <genre>" rail per top genre', async () => {
    const abs = makeAbs(
      [libraryBook('sf-1', 'Hyperion', 'Dan Simmons', ['Science Fiction']), libraryBook('fa-1', 'The Name of the Wind', 'Patrick Rothfuss', ['Fantasy'])],
      // 5.6 h of Science Fiction outweighs 2 h of Fantasy, so the order is deterministic.
      [progressRow('sf-1', { currentTime: 20000 }), progressRow('fa-1', { currentTime: 7200 })]
    )
    const browseDiscover = vi.fn<BrowseFn>().mockImplementation((params) => Promise.resolve(page(params.genre === 'Science Fiction' ? suggestions(1, 3) : suggestions(11, 3))))
    renderDiscover({ path: `${BROWSE_PATH}&catalog=for_you`, abs, acquisition: makeAcquisition({ browseDiscover }) })

    const sfRail = await screen.findByRole('heading', { name: 'Popular in Science Fiction' })
    const fantasyRail = await screen.findByRole('heading', { name: 'Popular in Fantasy' })
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Popular in Science Fiction', 'Popular in Fantasy'])

    const sf = within(sfRail.closest('section') as HTMLElement)
    expect(sf.getByText('Suggestion 1')).toBeInTheDocument()
    expect(sf.getByText('Suggestion 3')).toBeInTheDocument()
    expect(sf.queryByText('Suggestion 11')).not.toBeInTheDocument()
    const fantasy = within(fantasyRail.closest('section') as HTMLElement)
    expect(fantasy.getByText('Suggestion 11')).toBeInTheDocument()

    expect(requested(browseDiscover)).toEqual(
      expect.arrayContaining([
        { catalog: 'popular', genre: 'Science Fiction', offset: 0 },
        { catalog: 'popular', genre: 'Fantasy', offset: 0 }
      ])
    )
    expect(requested(browseDiscover)).toHaveLength(2)
    expect(screen.queryByText(TEXT.forYouEmpty)).not.toBeInTheDocument()
  })

  // 52 of the 103 real books are tagged only "Audiobook"/"Audiobooks"; a rail for them would be
  // "popular audiobooks", which says nothing about taste.
  it('never turns a noise genre into a rail', async () => {
    const abs = makeAbs(
      [libraryBook('sf-1', 'Hyperion', 'Dan Simmons', ['Audiobook', 'Science Fiction']), libraryBook('noise-1', 'Some Novel', 'Someone', ['Audiobooks'])],
      // The noise-only book is listened to far MORE, so it would win if noise were counted.
      [progressRow('sf-1', { currentTime: 20000 }), progressRow('noise-1', { currentTime: 100000, duration: 120000 })]
    )
    const browseDiscover = vi.fn<BrowseFn>().mockImplementation(() => Promise.resolve(page(suggestions(1, 3))))
    renderDiscover({ path: `${BROWSE_PATH}&catalog=for_you`, abs, acquisition: makeAcquisition({ browseDiscover }) })

    expect(await screen.findByRole('heading', { name: 'Popular in Science Fiction' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Popular in Audiobook' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Popular in Audiobooks' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /Audiobook/i })).not.toBeInTheDocument()
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(1)
    expect(requested(browseDiscover).map((p) => p.genre)).toEqual(['Science Fiction'])
  })

  it('shows the For-you empty state, and asks upstream nothing, when every listened genre is noise', async () => {
    const abs = makeAbs([libraryBook('noise-1', 'Some Novel', 'Someone', ['Audiobook'])], [progressRow('noise-1')])
    const browseDiscover = vi.fn<BrowseFn>().mockResolvedValue(page(suggestions(1, 3)))
    renderDiscover({ path: `${BROWSE_PATH}&catalog=for_you`, abs, acquisition: makeAcquisition({ browseDiscover }) })

    expect(await screen.findByText(TEXT.forYouEmpty)).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument()
    expect(browseDiscover).not.toHaveBeenCalled()
  })

  it('ignores a book listened to for less than the 1800 s engagement gate', async () => {
    const abs = makeAbs(
      [libraryBook('sf-1', 'Hyperion', 'Dan Simmons', ['Science Fiction']), libraryBook('fa-1', 'The Name of the Wind', 'Patrick Rothfuss', ['Fantasy'])],
      [progressRow('sf-1', { currentTime: 20000 }), progressRow('fa-1', { currentTime: 1799 })]
    )
    const browseDiscover = vi.fn<BrowseFn>().mockImplementation(() => Promise.resolve(page(suggestions(1, 3))))
    renderDiscover({ path: `${BROWSE_PATH}&catalog=for_you`, abs, acquisition: makeAcquisition({ browseDiscover }) })

    expect(await screen.findByRole('heading', { name: 'Popular in Science Fiction' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Popular in Fantasy' })).not.toBeInTheDocument()
    expect(requested(browseDiscover).map((p) => p.genre)).toEqual(['Science Fiction'])
  })

  it('keeps the rows that loaded and says some did not when one genre request fails', async () => {
    const abs = makeAbs(
      [libraryBook('sf-1', 'Hyperion', 'Dan Simmons', ['Science Fiction']), libraryBook('fa-1', 'The Name of the Wind', 'Patrick Rothfuss', ['Fantasy'])],
      [progressRow('sf-1', { currentTime: 20000 }), progressRow('fa-1', { currentTime: 7200 })]
    )
    const browseDiscover = vi.fn<BrowseFn>().mockImplementation((params) => (params.genre === 'Fantasy' ? Promise.reject(gatewayError('discover_upstream_unavailable')) : Promise.resolve(page(suggestions(1, 3)))))
    renderDiscover({ path: `${BROWSE_PATH}&catalog=for_you`, abs, acquisition: makeAcquisition({ browseDiscover }) })

    expect(await screen.findByRole('heading', { name: 'Popular in Science Fiction' })).toBeInTheDocument()
    expect(screen.getByText('Some suggestions could not be loaded.')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Popular in Fantasy' })).not.toBeInTheDocument()
  })

  // Three situations, three sentences (hook `reason`): no usable genre at all, a genre that came
  // back with nothing, and an outage.
  it('says "no suggestions came back" -- not "listen to a few books" -- when the listener has history but nothing came back', async () => {
    const user = userEvent.setup()
    const abs = makeAbs([libraryBook('sf-1', 'Hyperion', 'Dan Simmons', ['Science Fiction'])], [progressRow('sf-1', { currentTime: 20000 })])
    const browseDiscover = vi.fn<BrowseFn>().mockResolvedValue(page([], { status: 'empty' }))
    renderDiscover({ path: `${BROWSE_PATH}&catalog=for_you`, abs, acquisition: makeAcquisition({ browseDiscover }) })

    expect(await screen.findByText(TEXT.forYouNoMatches)).toBeInTheDocument()
    expect(screen.queryByText(TEXT.forYouEmpty)).not.toBeInTheDocument()
    expect(requested(browseDiscover).map((p) => p.genre)).toEqual(['Science Fiction'])
    // Still not an alert (nothing failed), and the way forward is offered.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: TEXT.browsePopular }))
    expect(screen.getByLabelText('Open Library catalog')).toHaveValue('popular')
  })

  it('says "listen to a few books" only when the listener has no usable genre', async () => {
    renderDiscover({ path: `${BROWSE_PATH}&catalog=for_you` })

    expect(await screen.findByText(TEXT.forYouEmpty)).toBeInTheDocument()
    expect(screen.queryByText(TEXT.forYouNoMatches)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: TEXT.browsePopular })).toBeInTheDocument()
  })

  it('shows the generic failure wording, never an empty-shelf sentence, when every For-you genre request fails', async () => {
    const abs = makeAbs([libraryBook('sf-1', 'Hyperion', 'Dan Simmons', ['Science Fiction'])], [progressRow('sf-1', { currentTime: 20000 })])
    const browseDiscover = vi.fn<BrowseFn>().mockRejectedValue(gatewayError('librarr_timeout'))
    renderDiscover({ path: `${BROWSE_PATH}&catalog=for_you`, abs, acquisition: makeAcquisition({ browseDiscover }) })

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(TEXT.failed)
    expect(alert).not.toHaveTextContent('Open Library')
    expect(screen.queryByText(TEXT.forYouEmpty)).not.toBeInTheDocument()
    expect(screen.queryByText(TEXT.forYouNoMatches)).not.toBeInTheDocument()
  })

  // `partial`: Librarr fell back to relevance order for a ranked catalog, so the row is not a
  // popularity ranking and must not be headed "Popular in ...".
  it('headers a partial row "Related in <genre>" and leaves ordinary rows as "Popular in <genre>"', async () => {
    const abs = makeAbs(
      [libraryBook('sf-1', 'Hyperion', 'Dan Simmons', ['Science Fiction']), libraryBook('fa-1', 'The Name of the Wind', 'Patrick Rothfuss', ['Fantasy'])],
      [progressRow('sf-1', { currentTime: 20000 }), progressRow('fa-1', { currentTime: 7200 })]
    )
    const browseDiscover = vi
      .fn<BrowseFn>()
      .mockImplementation((params) => Promise.resolve(params.genre === 'Fantasy' ? page(suggestions(11, 3), { partial: true }) : page(suggestions(1, 3))))
    renderDiscover({ path: `${BROWSE_PATH}&catalog=for_you`, abs, acquisition: makeAcquisition({ browseDiscover }) })

    expect(await screen.findByRole('heading', { name: 'Popular in Science Fiction' })).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Related in Fantasy' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Popular in Fantasy' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Related in Science Fiction' })).not.toBeInTheDocument()
  })
})
