import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AbsClient } from '../api/absClient'
import { AuthContext, type AuthContextValue } from '../auth/AuthProvider'
import { DownloadProvider } from '../downloads/DownloadProvider'
import type { RawDownloadEvent } from '../downloads/downloadTypes'
import type { AbsLibraryItem, AbsPlaybackSession } from '../types/abs'
import BookDetailsPage from './BookDetailsPage'
import DownloadsPage from './DownloadsPage'

type Listener = (event: RawDownloadEvent) => void

const listeners: Record<string, Listener[]> = { downloadProgress: [], downloadComplete: [], downloadFailed: [] }

function emit(eventName: string, event: RawDownloadEvent) {
  listeners[eventName]?.forEach((listener) => listener(event))
}

const enqueueMock = vi.fn().mockResolvedValue({ id: 'book-1' })

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
    remove: vi.fn().mockResolvedValue(undefined),
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
    listLocalItems: vi.fn().mockResolvedValue({ items: [] }),
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
    client: client as AbsClient,
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
    enqueueMock.mockClear()
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

    const downloadButton = await screen.findByRole('button', { name: 'Download' })
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

    const absFileSystem = (await import('../native/absFileSystemPlugin')).default
    ;(absFileSystem.listLocalItems as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [{ libraryItemId: 'book-1', serverConnectionId: 'https://books.test', folderUri: '/downloads/book-1', manifestJson: '{"title":"Project Hail Mary"}', completedAt: 1 }]
    })

    // Downloads route re-render: simplest way to force DownloadsPage's own local-items list to
    // reflect the queued completion within this render tree is to navigate there directly.
    render(
      <AuthContext.Provider
        value={{
          state: { status: 'authenticated', serverUrl: 'https://books.test' },
          client: client as AbsClient,
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

    expect(await screen.findByText('Project Hail Mary')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Play offline' })).toBeEnabled()
  })
})
