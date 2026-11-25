import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AbsClient } from '../api/absClient'
import { AuthContext, type AuthContextValue } from '../auth/AuthProvider'
import { withClientDefaults } from '../test/absClientMock'
import { DownloadProvider } from '../downloads/DownloadProvider'
import type { RawDownloadEvent } from '../downloads/downloadTypes'
import { cacheServerProgress, localOfflineProgressStorage } from '../player/offlineProgress'
import type { AbsLibraryItem, AbsPlaybackSession } from '../types/abs'
import BookDetailsPage from './BookDetailsPage'
import DownloadsPage from './DownloadsPage'

type Listener = (event: RawDownloadEvent) => void

const listeners: Record<string, Listener[]> = { downloadProgress: [], downloadComplete: [], downloadFailed: [] }

function emit(eventName: string, event: RawDownloadEvent) {
  listeners[eventName]?.forEach((listener) => listener(event))
}

const enqueueMock = vi.fn().mockResolvedValue({ id: 'book-1' })
const removeMock = vi.fn().mockResolvedValue(undefined)
const setWifiOnlyMock = vi.fn().mockResolvedValue(undefined)
const listLocalItemsMock = vi.fn()

vi.mock('@capacitor/core', async () => {
  const actual = await vi.importActual<typeof import('@capacitor/core')>('@capacitor/core')
  return { ...actual, Capacitor: { ...actual.Capacitor, isNativePlatform: () => true } }
})

vi.mock('../native/absDownloaderPlugin', () => ({
  default: {
    enqueue: (options: unknown) => enqueueMock(options),
    pause: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    remove: (options: unknown) => removeMock(options),
    setWifiOnly: (options: unknown) => setWifiOnlyMock(options),
    listQueue: vi.fn().mockResolvedValue({ items: [] }),
    addListener: (eventName: string, listener: Listener) => {
      listeners[eventName] = listeners[eventName] ?? []
      listeners[eventName].push(listener)
      return Promise.resolve({ remove: () => Promise.resolve() })
    }
  }
}))

vi.mock('../native/absFileSystemPlugin', () => ({
  default: {
    listLocalItems: () => listLocalItemsMock(),
    chooseDownloadFolder: vi.fn().mockResolvedValue(null),
    deleteLocalItem: vi.fn().mockResolvedValue(undefined)
  }
}))

function bookFixture(): AbsLibraryItem {
  return {
    id: 'book-1',
    libraryId: 'lib1',
    media: { metadata: { title: 'Project Hail Mary', authorName: 'Andy Weir' } }
  }
}

function session(): AbsPlaybackSession {
  return { id: 'session-1', currentTime: 0, audioTracks: [{ index: 0, contentUrl: '/api/items/book-1/file/f1', duration: 3600 }] }
}

function renderApp(client: Partial<AbsClient>) {
  const authValue: AuthContextValue = {
    state: { status: 'authenticated', serverUrl: 'https://books.test' },
    client: withClientDefaults(client),
    acquisitionClient: null,
    login: vi.fn(),
    logout: vi.fn()
  }
  return render(
    <AuthContext.Provider value={authValue}>
      <DownloadProvider>
        <MemoryRouter initialEntries={['/library/lib1/item/book-1']}>
          <Routes>
            <Route path="/library/:libraryId/item/:itemId" element={<BookDetailsPage />} />
            <Route path="/downloads" element={<DownloadsPage />} />
          </Routes>
        </MemoryRouter>
      </DownloadProvider>
    </AuthContext.Provider>
  )
}

describe('DownloadsPage', () => {
  beforeEach(() => {
    window.localStorage.removeItem('shelfdroid.offlineProgress')
    enqueueMock.mockClear()
    removeMock.mockClear()
    setWifiOnlyMock.mockClear()
    listLocalItemsMock.mockReset().mockResolvedValue({ items: [] })
    listeners.downloadProgress = []
    listeners.downloadComplete = []
    listeners.downloadFailed = []
  })

  it('queues a book once and exposes completed items offline', async () => {
    const user = userEvent.setup()
    const client: Partial<AbsClient> = {
      getLibraryItem: vi.fn().mockResolvedValue(bookFixture()),
      startSession: vi.fn().mockResolvedValue(session()),
      getAccessToken: () => 'token-1',
      getServerUrl: () => 'https://books.test'
    }
    renderApp(client)

    const downloadButton = await screen.findByRole('button', { name: 'Download to device' })
    await user.click(downloadButton)

    expect(enqueueMock).toHaveBeenCalledTimes(1)
    expect(enqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({ libraryItemId: 'book-1', title: 'Project Hail Mary', accessToken: 'token-1', serverUrl: 'https://books.test' })
    )

    emit('downloadComplete', {
      id: 'book-1',
      libraryItemId: 'book-1',
      title: 'Project Hail Mary',
      bytesDownloaded: 100,
      totalBytes: 100,
      state: 'complete',
      error: null
    })

    listLocalItemsMock.mockResolvedValue({
      items: [{ libraryItemId: 'book-1', serverConnectionId: 'https://books.test', folderUri: '/downloads/book-1', manifestJson: '{"title":"Project Hail Mary"}', completedAt: 1 }]
    })

    // Downloads route re-render: simplest way to force DownloadsPage's own local-items list to
    // reflect the queued completion within this render tree is to navigate there directly.
    render(
      <AuthContext.Provider
        value={{
          state: { status: 'authenticated', serverUrl: 'https://books.test' },
          client: withClientDefaults(client),
          acquisitionClient: null,
          login: vi.fn(),
          logout: vi.fn()
        }}
      >
        <DownloadProvider>
          <MemoryRouter initialEntries={['/downloads']}>
            <Routes>
              <Route path="/downloads" element={<DownloadsPage />} />
            </Routes>
          </MemoryRouter>
        </DownloadProvider>
      </AuthContext.Provider>
    )

    // The book title is also on screen from the first render tree, so wait on the offline row itself.
    expect(await screen.findByRole('button', { name: 'Play offline' })).toBeEnabled()
  })

  it('closes the play session it opened and only asks for direct-file formats', async () => {
    const user = userEvent.setup()
    const closeSession = vi.fn().mockResolvedValue(undefined)
    const startSession = vi.fn().mockResolvedValue(session())
    renderApp({ getLibraryItem: vi.fn().mockResolvedValue(bookFixture()), startSession, closeSession })

    await user.click(await screen.findByRole('button', { name: 'Download to device' }))

    expect(enqueueMock).toHaveBeenCalledTimes(1)
    const options = startSession.mock.calls[0][1] as { supportedMimeTypes: string[]; forceDirectPlay: boolean }
    expect(options.supportedMimeTypes).not.toContain('application/vnd.apple.mpegurl')
    expect(options.forceDirectPlay).toBe(true)
    expect(closeSession).toHaveBeenCalledWith('session-1', expect.objectContaining({ timeListened: 0 }))
  })

  it('caches the server position when queueing, refreshes it on completion, and never clobbers a listened position', async () => {
    const user = userEvent.setup()
    const startSession = vi.fn().mockResolvedValue({ ...session(), currentTime: 843 })
    const getMe = vi.fn().mockResolvedValue({
      id: 'u1',
      username: 'tester',
      mediaProgress: [{ id: 'p1', libraryItemId: 'book-1', currentTime: 900, duration: 3600, isFinished: false, progress: 0.25 }]
    })
    renderApp({ getLibraryItem: vi.fn().mockResolvedValue(bookFixture()), startSession, closeSession: vi.fn().mockResolvedValue(undefined), getMe })

    await user.click(await screen.findByRole('button', { name: 'Download to device' }))
    expect(localOfflineProgressStorage.read('book-1')).toMatchObject({ currentTime: 843, source: 'server-cache', unsyncedTimeListened: 0 })

    act(() => emit('downloadComplete', { id: 'book-1', libraryItemId: 'book-1', title: 'T', bytesDownloaded: 1, totalBytes: 1, state: 'complete', error: null }))
    await waitFor(() => expect(localOfflineProgressStorage.read('book-1')?.currentTime).toBe(900))
    expect(localOfflineProgressStorage.read('book-1')?.source).toBe('server-cache')

    // A position the listener really reached is newer than any server snapshot and is left alone.
    localOfflineProgressStorage.write('book-1', { currentTime: 30, duration: 3600, unsyncedTimeListened: 20, updatedAt: 1 })
    act(() => emit('downloadComplete', { id: 'book-1', libraryItemId: 'book-1', title: 'T', bytesDownloaded: 1, totalBytes: 1, state: 'complete', error: null }))
    await waitFor(() => expect(getMe).toHaveBeenCalledTimes(2))
    expect(localOfflineProgressStorage.read('book-1')).toEqual({ currentTime: 30, duration: 3600, unsyncedTimeListened: 20, updatedAt: 1 })
  })

  it('removing a download clears its cached server position', async () => {
    const user = userEvent.setup()
    cacheServerProgress('book-1', 843)
    listLocalItemsMock.mockResolvedValue({
      items: [{ libraryItemId: 'book-1', serverConnectionId: 'https://books.test', folderUri: '/downloads/book-1', manifestJson: '{"title":"Project Hail Mary"}', completedAt: 1 }]
    })
    render(
      <AuthContext.Provider
        value={{ state: { status: 'authenticated', serverUrl: 'https://books.test' }, client: withClientDefaults({}), acquisitionClient: null, login: vi.fn(), logout: vi.fn() }}
      >
        <DownloadProvider>
          <MemoryRouter initialEntries={['/downloads']}>
            <Routes>
              <Route path="/downloads" element={<DownloadsPage />} />
            </Routes>
          </MemoryRouter>
        </DownloadProvider>
      </AuthContext.Provider>
    )
    expect(localOfflineProgressStorage.read('book-1')).not.toBeNull()

    await user.click(await screen.findByRole('button', { name: 'Delete Project Hail Mary' }))
    listLocalItemsMock.mockResolvedValue({ items: [] })
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(removeMock).toHaveBeenCalledWith({ libraryItemId: 'book-1' }))
    await waitFor(() => expect(localOfflineProgressStorage.read('book-1')).toBeNull())
  })

  it('refuses a session that only offers an HLS playlist and still closes it', async () => {
    const user = userEvent.setup()
    const closeSession = vi.fn().mockResolvedValue(undefined)
    const hls: AbsPlaybackSession = { id: 'session-hls', currentTime: 0, audioTracks: [{ index: 0, contentUrl: '/hls/session-hls/output.m3u8', duration: 3600 }] }
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    renderApp({ getLibraryItem: vi.fn().mockResolvedValue(bookFixture()), startSession: vi.fn().mockResolvedValue(hls), closeSession })

    await user.click(await screen.findByRole('button', { name: 'Download to device' }))

    expect(enqueueMock).not.toHaveBeenCalled()
    expect(closeSession).toHaveBeenCalledWith('session-hls', expect.anything())
    consoleError.mockRestore()
  })

  it('pushes the persisted Wi-Fi-only preference to the native policy before enqueueing', async () => {
    const user = userEvent.setup()
    window.localStorage.setItem('shelfdroid.settings', JSON.stringify({ wifiOnly: true }))
    renderApp({ getLibraryItem: vi.fn().mockResolvedValue(bookFixture()), startSession: vi.fn().mockResolvedValue(session()), closeSession: vi.fn().mockResolvedValue(undefined) })

    await user.click(await screen.findByRole('button', { name: 'Download to device' }))

    expect(setWifiOnlyMock).toHaveBeenCalledWith({ wifiOnly: true })
    window.localStorage.removeItem('shelfdroid.settings')
  })

  it('lets a cancelled or failed download be started again', async () => {
    const user = userEvent.setup()
    const startSession = vi.fn().mockResolvedValue(session())
    renderApp({ getLibraryItem: vi.fn().mockResolvedValue(bookFixture()), startSession, closeSession: vi.fn().mockResolvedValue(undefined) })

    await user.click(await screen.findByRole('button', { name: 'Download to device' }))
    expect(enqueueMock).toHaveBeenCalledTimes(1)

    act(() => emit('downloadProgress', { id: 'book-1', libraryItemId: 'book-1', title: 'T', bytesDownloaded: 0, totalBytes: 0, state: 'running' }))
    await user.click(await screen.findByRole('button', { name: 'Download to device' }))
    expect(enqueueMock).toHaveBeenCalledTimes(1) // still in flight: deduped

    act(() => emit('downloadProgress', { id: 'book-1', libraryItemId: 'book-1', title: 'T', bytesDownloaded: 0, totalBytes: 0, state: 'cancelled' }))
    await user.click(await screen.findByRole('button', { name: 'Download to device' }))
    expect(enqueueMock).toHaveBeenCalledTimes(2)
  })

  it('deletes an offline book after confirmation and lets it be downloaded again', async () => {
    const user = userEvent.setup()
    listLocalItemsMock.mockResolvedValue({
      items: [{ libraryItemId: 'book-1', serverConnectionId: 'https://books.test', folderUri: '/downloads/book-1', manifestJson: '{"title":"Project Hail Mary"}', completedAt: 1 }]
    })
    render(
      <AuthContext.Provider
        value={{ state: { status: 'authenticated', serverUrl: 'https://books.test' }, client: withClientDefaults({}), acquisitionClient: null, login: vi.fn(), logout: vi.fn() }}
      >
        <DownloadProvider>
          <MemoryRouter initialEntries={['/downloads']}>
            <Routes>
              <Route path="/downloads" element={<DownloadsPage />} />
            </Routes>
          </MemoryRouter>
        </DownloadProvider>
      </AuthContext.Provider>
    )

    await user.click(await screen.findByRole('button', { name: 'Delete Project Hail Mary' }))
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Delete "Project Hail Mary" from this device?')
    expect(removeMock).not.toHaveBeenCalled()

    // After the native delete the catalog no longer lists the book.
    listLocalItemsMock.mockResolvedValue({ items: [] })
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }))

    expect(removeMock).toHaveBeenCalledWith({ libraryItemId: 'book-1' })
    expect(await screen.findByText('Nothing downloaded yet.')).toBeInTheDocument()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('shows the author and the locally stored cover for a downloaded book, and still lists an old manifest by title', async () => {
    listLocalItemsMock.mockResolvedValue({
      items: [
        {
          libraryItemId: 'book-1',
          serverConnectionId: 'https://books.test',
          folderUri: '/downloads/book-1',
          manifestJson: JSON.stringify({ title: 'Project Hail Mary', author: 'Andy Weir', coverPath: '/data/downloads/book-1/cover.jpg', tracks: [{ trackIndex: 0, path: '/data/downloads/book-1/track-0.mp3' }] }),
          completedAt: 1
        },
        { libraryItemId: 'book-2', serverConnectionId: 'https://books.test', folderUri: '/downloads/book-2', manifestJson: '{"title":"Old Download"}', completedAt: 1 }
      ]
    })
    render(
      <AuthContext.Provider
        value={{ state: { status: 'authenticated', serverUrl: 'https://books.test' }, client: withClientDefaults({}), acquisitionClient: null, login: vi.fn(), logout: vi.fn() }}
      >
        <DownloadProvider>
          <MemoryRouter initialEntries={['/downloads']}>
            <Routes>
              <Route path="/downloads" element={<DownloadsPage />} />
            </Routes>
          </MemoryRouter>
        </DownloadProvider>
      </AuthContext.Provider>
    )

    const rows = await screen.findAllByTestId('download-local-row')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]).getByText('Project Hail Mary')).toBeInTheDocument()
    expect(within(rows[0]).getByText('Andy Weir')).toBeInTheDocument()
    expect(within(rows[0]).getByTestId('download-local-cover').getAttribute('src')).toContain('/data/downloads/book-1/cover.jpg')
    expect(within(rows[1]).getByText('Old Download')).toBeInTheDocument()
    expect(within(rows[1]).queryByTestId('download-local-cover')).not.toBeInTheDocument()
  })

  it('keeps the book when the delete confirmation is dismissed', async () => {
    const user = userEvent.setup()
    listLocalItemsMock.mockResolvedValue({
      items: [{ libraryItemId: 'book-1', serverConnectionId: 'https://books.test', folderUri: '/downloads/book-1', manifestJson: '{"title":"Project Hail Mary"}', completedAt: 1 }]
    })
    render(
      <AuthContext.Provider
        value={{ state: { status: 'authenticated', serverUrl: 'https://books.test' }, client: withClientDefaults({}), acquisitionClient: null, login: vi.fn(), logout: vi.fn() }}
      >
        <DownloadProvider>
          <MemoryRouter initialEntries={['/downloads']}>
            <Routes>
              <Route path="/downloads" element={<DownloadsPage />} />
            </Routes>
          </MemoryRouter>
        </DownloadProvider>
      </AuthContext.Provider>
    )

    await user.click(await screen.findByRole('button', { name: 'Delete Project Hail Mary' }))
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }))

    expect(removeMock).not.toHaveBeenCalled()
    expect(screen.getByText('Project Hail Mary')).toBeInTheDocument()
  })
})
