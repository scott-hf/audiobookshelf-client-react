import { describe, expect, it } from 'vitest'
import { mergeClasses } from './merge-classes'

/**
 * The custom font sizes registered in `src/theme/index.css` (`--text-*`). tailwind-merge only knows
 * Tailwind's built-in scale, so without `extendTailwindMerge` it files these with the text COLOUR
 * utilities and drops them when a colour follows (Badge: `text-xxs` ... `text-success`).
 * Keep this list in step with the @theme block: a token added there needs registering in
 * merge-classes.ts and a row here.
 */
const CUSTOM_FONT_SIZES = ['text-xxs', 'text-1.5xl', 'text-2.5xl', 'text-4.5xl']

describe('mergeClasses', () => {
  describe.each(CUSTOM_FONT_SIZES)('custom font size %s', (size) => {
    // Negative control: these fail against a plain twMerge (size and colour share one group).
    it('survives a text colour that follows it', () => {
      expect(mergeClasses(size, 'text-success').split(' ')).toEqual([size, 'text-success'])
    })

    it('survives a text colour that precedes it', () => {
      expect(mergeClasses('text-success', size).split(' ')).toEqual(['text-success', size])
    })

    it('survives a themed colour token (Badge neutral tone)', () => {
      expect(mergeClasses(size, 'text-foreground-muted').split(' ')).toEqual([size, 'text-foreground-muted'])
    })

    it('still conflicts with a built-in font size, last one wins', () => {
      expect(mergeClasses(size, 'text-sm')).toBe('text-sm')
      expect(mergeClasses('text-sm', size)).toBe(size)
    })

    it('is replaced by a later arbitrary font size', () => {
      expect(mergeClasses(size, 'text-[0.75rem]')).toBe('text-[0.75rem]')
    })
  })

  it('custom sizes conflict with each other, last one wins', () => {
    expect(mergeClasses('text-xxs', 'text-1.5xl')).toBe('text-1.5xl')
  })

  // Regression guards: these already passed on a plain twMerge, so they are NOT negative controls.
  // They prove the extension did not break the built-in behaviour.
  it('built-in font sizes and colours still coexist', () => {
    expect(mergeClasses('text-sm', 'text-error').split(' ')).toEqual(['text-sm', 'text-error'])
  })

  it('later text colour still replaces an earlier one', () => {
    expect(mergeClasses('text-success', 'text-error')).toBe('text-error')
  })

  it('later built-in font size still replaces an earlier one', () => {
    expect(mergeClasses('text-xs', 'text-lg')).toBe('text-lg')
  })
})
