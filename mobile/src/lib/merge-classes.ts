import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/**
 * The custom `--text-*` font sizes from `src/theme/index.css`. tailwind-merge only knows Tailwind's
 * built-in scale, so it cannot tell that `text-xxs` is a font SIZE and files it with the text
 * COLOUR utilities; the later colour then evicts it (Badge: `text-xxs ... text-success` rendered
 * at the inherited size). Registering the tokens puts them in the `font-size` group.
 *
 * Only `xxs` is actually mis-grouped today: tailwind-merge's t-shirt-size matcher happens to accept
 * `1.5xl`/`2.5xl`/`4.5xl` already. They are listed anyway so the registry mirrors the @theme block
 * and does not depend on that heuristic. Add any new `--text-*` token here too.
 */
const CUSTOM_FONT_SIZES = ['xxs', '1.5xl', '2.5xl', '4.5xl']

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: CUSTOM_FONT_SIZES }]
    }
  }
})

export function mergeClasses(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
