import type { DiscoverItem } from '@abs/acquisition-contract'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { OwnedIndexEntry, OwnedMatch } from '../lib/discoverBrowse'
import DiscoverBookCard from './DiscoverBookCard'

const ITEM: DiscoverItem = { key: '/works/OL17930368W', title: 'Atomic Habits', author: 'James Clear', coverUrl: null, year: 2018, popularity: 66698 }
const ENTRY: OwnedIndexEntry = { id: 'li_atomic', title: 'Atomic Habits', author: 'James Clear', genres: [] }

function renderCard(owned: OwnedMatch, item: DiscoverItem = ITEM) {
  const onOpenOwned = vi.fn()
  const onSearch = vi.fn()
  render(<DiscoverBookCard item={item} owned={owned} onOpenOwned={onOpenOwned} onSearch={onSearch} />)
  return { onOpenOwned, onSearch }
}

describe('DiscoverBookCard', () => {
  it('a confident match shows the badge and opens the library book', async () => {
    const { onOpenOwned, onSearch } = renderCard({ kind: 'confident', entry: ENTRY })

    expect(screen.getByText('In server library')).toBeInTheDocument()
    const card = screen.getByRole('button', { name: 'Atomic Habits by James Clear. Open in your library' })
    await userEvent.click(card)

    expect(onOpenOwned).toHaveBeenCalledTimes(1)
    expect(onOpenOwned).toHaveBeenCalledWith('li_atomic')
    expect(onSearch).not.toHaveBeenCalled()
  })

  it('an ambiguous match has no badge and does not navigate: it searches', async () => {
    const { onOpenOwned, onSearch } = renderCard({ kind: 'ambiguous', entries: [ENTRY, { ...ENTRY, id: 'li_other' }] })

    expect(screen.queryByText('In server library')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Atomic Habits by James Clear. Find a copy to acquire' }))

    expect(onSearch).toHaveBeenCalledTimes(1)
    expect(onSearch).toHaveBeenCalledWith(ITEM)
    expect(onOpenOwned).not.toHaveBeenCalled()
  })

  it('no match has no badge and searches', async () => {
    const { onOpenOwned, onSearch } = renderCard({ kind: 'none' })

    expect(screen.queryByText('In server library')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Atomic Habits by James Clear. Find a copy to acquire' }))

    expect(onSearch).toHaveBeenCalledTimes(1)
    expect(onSearch).toHaveBeenCalledWith(ITEM)
    expect(onOpenOwned).not.toHaveBeenCalled()
  })

  it('never renders the Open Library popularity count', () => {
    renderCard({ kind: 'none' })

    expect(document.body.textContent).not.toMatch(/66[, ]?698/)
  })

  it('renders title and author, and degrades to the text cover when there is no cover url', () => {
    renderCard({ kind: 'none' })

    // Title/author appear in the text card fallback and in the caption below the cover.
    expect(screen.getAllByText('Atomic Habits').length).toBeGreaterThan(0)
    expect(screen.getAllByText('James Clear').length).toBeGreaterThan(0)
    expect(document.querySelector('img')).toBeNull()
  })

  it('renders the cover image when a url is given', () => {
    renderCard({ kind: 'none' }, { ...ITEM, coverUrl: 'https://covers.test/a.jpg' })

    expect(document.querySelector('img')?.getAttribute('src')).toBe('https://covers.test/a.jpg')
  })
})
