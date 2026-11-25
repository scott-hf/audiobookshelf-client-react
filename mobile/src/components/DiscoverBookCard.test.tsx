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

  // The pill used to be a block in the card's flow: wider than a 3-column cell (it bled into the
  // neighbouring entry) and a row taller than an unowned card. These specs assert DOM structure and
  // utility classes only -- jsdom loads no stylesheet, so they cannot measure layout or pixels.
  describe('owned pill overlay', () => {
    const pillOf = () => screen.getByText('In server library').closest('.absolute') as HTMLElement | null

    it('sits inside the cover wrapper, out of the card flow, not as a row under the title', () => {
      renderCard({ kind: 'confident', entry: ENTRY })
      const card = screen.getByRole('button')
      const pill = pillOf()

      expect(pill).not.toBeNull()
      // The overlay's offset parent is the wrapper that also holds the cover, not the card itself.
      const wrapper = pill!.parentElement as HTMLElement
      expect(wrapper).not.toBe(card)
      expect(wrapper.className).toContain('relative')
      expect(wrapper.contains(document.querySelector('.aspect-2\\/3'))).toBe(true)
      // And it is not a direct child of the button, where it would take part in the flex column.
      expect(Array.from(card.children)).not.toContain(pill)
    })

    it('adds no in-flow child, so an owned card and an unowned card have the same structure', () => {
      const { unmount } = render(<DiscoverBookCard item={ITEM} owned={{ kind: 'confident', entry: ENTRY }} onOpenOwned={vi.fn()} onSearch={vi.fn()} />)
      const ownedChildren = screen.getByRole('button').children.length
      unmount()
      render(<DiscoverBookCard item={ITEM} owned={{ kind: 'none' }} onOpenOwned={vi.fn()} onSearch={vi.fn()} />)
      const unownedChildren = screen.getByRole('button').children.length

      expect(ownedChildren).toBe(unownedChildren)
    })

    it('is decorative and inert: hidden from assistive tech, ignores pointer events, holds no control', () => {
      renderCard({ kind: 'confident', entry: ENTRY })
      const pill = pillOf()

      expect(pill).toHaveAttribute('aria-hidden', 'true')
      expect(pill!.className).toContain('pointer-events-none')
      expect(pill!.querySelector('button, a, input, [role="button"], [tabindex]')).toBeNull()
      // The whole card stays one button, and the owned/not-owned distinction survives in its name.
      expect(screen.getAllByRole('button')).toHaveLength(1)
      expect(screen.getByRole('button')).toHaveAccessibleName('Atomic Habits by James Clear. Open in your library')
    })

    it('has an opaque backing and cannot bleed past a narrow cover', () => {
      renderCard({ kind: 'confident', entry: ENTRY })
      const badge = screen.getByText('In server library').closest('[class*="bg-success"]') as HTMLElement

      // `bg-success/20` (the inline tone) is a 20% tint: unreadable over a light cover.
      expect(badge.className).toMatch(/(^|\s)bg-success(\s|$)/)
      expect(badge.className).not.toMatch(/bg-success\//)
      // Capped to the cover's width; overflow truncates with an ellipsis instead of spilling out.
      expect(badge.className).toContain('max-w-full')
      expect(screen.getByText('In server library').className).toContain('truncate')
    })

    it('a click on the pill still reaches the card (no-op by construction in jsdom: pointer-events CSS is not applied)', async () => {
      const { onOpenOwned } = renderCard({ kind: 'confident', entry: ENTRY })
      await userEvent.click(screen.getByText('In server library'))

      expect(onOpenOwned).toHaveBeenCalledWith('li_atomic')
    })
  })
})
