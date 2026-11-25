import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import SelectField from './SelectField'

function field(layout?: 'inline' | 'stacked', onChange = vi.fn()) {
  return render(
    <SelectField id="genre" label="Genre" value="a" onChange={onChange} layout={layout}>
      <option value="a">Alpha</option>
      <option value="b">Beta</option>
    </SelectField>
  )
}

describe('SelectField', () => {
  it('defaults to the inline layout: label and select side by side', () => {
    const { container } = field()
    const root = container.firstElementChild as HTMLElement

    expect(root.className).toContain('flex items-center justify-between')
    expect(root.className).not.toContain('flex-col')
    expect(screen.getByLabelText('Genre').className).not.toContain('w-full')
  })

  it('inline and omitted layouts render the same markup', () => {
    const omitted = field()
    const omittedHtml = omitted.container.innerHTML
    omitted.unmount()
    const inline = field('inline')

    expect(inline.container.innerHTML).toBe(omittedHtml)
  })

  it('stacked puts the label above a full-width select, still associated with it', () => {
    const { container } = field('stacked')
    const root = container.firstElementChild as HTMLElement
    const select = screen.getByLabelText('Genre')
    const label = screen.getByText('Genre')

    expect(select.tagName).toBe('SELECT')
    expect(root.className).toContain('flex-col')
    expect(root.className).not.toContain('justify-between')
    expect(select.className).toContain('w-full')
    // Label comes first in DOM order, so it renders above the select.
    expect(label.compareDocumentPosition(select) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('still reports changes from the native select in both layouts', async () => {
    for (const layout of ['inline', 'stacked'] as const) {
      const onChange = vi.fn()
      const { unmount } = field(layout, onChange)
      await userEvent.selectOptions(screen.getByLabelText('Genre'), 'b')
      expect(onChange).toHaveBeenCalledTimes(1)
      unmount()
    }
  })
})
