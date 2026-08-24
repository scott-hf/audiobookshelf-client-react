import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { AbsClient } from '../api/absClient'
import { AuthContext, type AuthContextValue } from '../auth/AuthProvider'
import type { AbsLibrary, AbsLibraryItem } from '../types/abs'
import BookDetailsPage from './BookDetailsPage'
import LibrariesPage from './LibrariesPage'
import LibraryPage from './LibraryPage'

function library(overrides: Partial<AbsLibrary> & { id: string }): AbsLibrary {
  return { name: 'Library', mediaType: 'book', ...overrides }
}

function book(overrides: Partial<AbsLibraryItem> & { id: string; title: string }): AbsLibraryItem {
  const { title, ...rest } = overrides
  return { libraryId: 'books', media: { metadata: { title, authorName: 'Author' } }, ...rest }
}

function renderMobile(initialPath: string, client: Partial<AbsClient>) {
  const authValue: AuthContextValue = {
    state: { status: 'authenticated', serverUrl: 'https://books.test' },
    client: client as AbsClient,
    acquisitionClient: null,
    login: vi.fn(),
    logout: vi.fn()
  }
  return render(
    <AuthContext.Provider value={authValue}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/libraries" element={<LibrariesPage />} />
          <Route path="/library/:libraryId" element={<LibraryPage />} />
          <Route path="/library/:libraryId/item/:itemId" element={<BookDetailsPage />} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>
  )
}

describe('LibrariesPage', () => {
  it('shows only book libraries', async () => {
    const getLibraries = vi.fn().mockResolvedValue({
      libraries: [library({ id: 'books', name: 'Books', mediaType: 'book' }), library({ id: 'podcasts', name: 'Podcasts', mediaType: 'podcast' })]
    })
    renderMobile('/libraries', { getLibraries })

    expect(await screen.findByText('Books')).toBeInTheDocument()
    expect(screen.queryByText('Podcasts')).not.toBeInTheDocument()
  })
})

describe('LibraryPage', () => {
  it('shows only book libraries and opens item details', async () => {
    const user = userEvent.setup()
    const getLibraryItems = vi.fn().mockResolvedValue({ results: [book({ id: 'b1', title: 'Project Hail Mary' })], total: 1 })
    const getLibraryItem = vi.fn().mockResolvedValue(book({ id: 'b1', title: 'Project Hail Mary' }))
    renderMobile('/library/books', { getLibraryItems, getLibraryItem })

    const title = await screen.findByText('Project Hail Mary')
    await user.click(title)

    expect(await screen.findByRole('heading', { name: 'Project Hail Mary' })).toBeInTheDocument()
    expect(getLibraryItem).toHaveBeenCalledWith('b1')
  })

  it('shows an empty state when the library has no books', async () => {
    const getLibraryItems = vi.fn().mockResolvedValue({ results: [], total: 0 })
    renderMobile('/library/books', { getLibraryItems })
    expect(await screen.findByText('No books in this library yet.')).toBeInTheDocument()
  })
})
