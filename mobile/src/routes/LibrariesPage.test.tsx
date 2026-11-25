import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { AbsClient } from '../api/absClient'
import { AuthContext, type AuthContextValue } from '../auth/AuthProvider'
import { withClientDefaults } from '../test/absClientMock'
import type { AbsLibrary } from '../types/abs'
import LibrariesPage from './LibrariesPage'

function library(id: string, name: string, mediaType = 'book'): AbsLibrary {
  return { id, name, mediaType } as AbsLibrary
}

/** Renders the current path, so a redirect is asserted on where the user ENDED UP. */
function Landed() {
  const { pathname } = useLocation()
  return <p>landed: {pathname}</p>
}

function renderLibraries(client: Partial<AbsClient>) {
  const authValue: AuthContextValue = {
    state: { status: 'authenticated', serverUrl: 'https://books.test' },
    client: withClientDefaults(client),
    acquisitionClient: null,
    login: vi.fn(),
    logout: vi.fn()
  }
  return render(
    <AuthContext.Provider value={authValue}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<LibrariesPage />} />
          <Route path="/library/:libraryId" element={<Landed />} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>
  )
}

describe('LibrariesPage', () => {
  it('goes straight into the only book library instead of showing a one-row list', async () => {
    const getLibraries = vi.fn().mockResolvedValue({ libraries: [library('only-one', 'MyBooks')] })

    renderLibraries({ getLibraries })

    expect(await screen.findByText('landed: /library/only-one')).toBeInTheDocument()
    // The list it skipped must never have been painted, not merely replaced afterwards.
    expect(screen.queryByRole('button', { name: /MyBooks/ })).not.toBeInTheDocument()
  })

  it('still lists them when the server has more than one book library', async () => {
    const getLibraries = vi.fn().mockResolvedValue({ libraries: [library('a', 'MyBooks'), library('b', 'Disposable Test')] })

    renderLibraries({ getLibraries })

    expect(await screen.findByRole('button', { name: /MyBooks/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Disposable Test/ })).toBeInTheDocument()
    expect(screen.queryByText(/^landed:/)).not.toBeInTheDocument()
  })

  it('auto-selects the sole BOOK library even when podcast libraries are also present', async () => {
    const getLibraries = vi.fn().mockResolvedValue({
      libraries: [library('books', 'MyBooks'), library('pods', 'Podcasts', 'podcast')]
    })

    renderLibraries({ getLibraries })

    expect(await screen.findByText('landed: /library/books')).toBeInTheDocument()
  })

  it('navigates to a chosen library when several are offered', async () => {
    const user = userEvent.setup()
    const getLibraries = vi.fn().mockResolvedValue({ libraries: [library('a', 'MyBooks'), library('b', 'Disposable Test')] })

    renderLibraries({ getLibraries })

    await user.click(await screen.findByRole('button', { name: /Disposable Test/ }))

    expect(await screen.findByText('landed: /library/b')).toBeInTheDocument()
  })

  it('shows the empty state rather than redirecting when the server has no book library', async () => {
    const getLibraries = vi.fn().mockResolvedValue({ libraries: [library('pods', 'Podcasts', 'podcast')] })

    renderLibraries({ getLibraries })

    expect(await screen.findByText('No book libraries available.')).toBeInTheDocument()
    expect(screen.queryByText(/^landed:/)).not.toBeInTheDocument()
  })

  it('reports a failure to load instead of redirecting anywhere', async () => {
    const getLibraries = vi.fn().mockRejectedValue(new Error('offline'))

    renderLibraries({ getLibraries })

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load libraries.')
    expect(screen.queryByText(/^landed:/)).not.toBeInTheDocument()
  })
})
