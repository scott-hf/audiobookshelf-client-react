import enUsMessages from '../locales/en-us.json'
import type { TranslationKey, TranslationValues, TypeSafeTranslations } from '../types/translations'

const messages = enUsMessages as Record<string, string>

/**
 * Mobile stand-in for the upstream `useTypeSafeTranslations`, which wraps next-intl.
 *
 * The mobile shell is a Vite SPA with no next-intl provider, so this resolves keys
 * directly against the bundled en-us catalog and supports the simple `{name}`
 * placeholder substitution that the ported ui/ components rely on. It deliberately
 * keeps the upstream call signature so ported components need no edits.
 *
 * Not supported (unused by anything ported so far): locale switching, plurals/select,
 * and rich tag callbacks -- `rich` returns the interpolated plain string.
 */
function interpolate(template: string, values?: TranslationValues): string {
  if (!values) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = values[name]
    return value === undefined ? match : String(value)
  })
}

function translate(key: TranslationKey, values?: TranslationValues): string {
  const template = messages[key]
  if (template === undefined) {
    if (import.meta.env.DEV) {
      console.warn(`[i18n] missing translation key: ${key}`)
    }
    return key
  }
  return interpolate(template, values)
}

const t = translate as TypeSafeTranslations
t.rich = ((key: TranslationKey, values?: Record<string, string | number>) => translate(key, values as TranslationValues)) as TypeSafeTranslations['rich']

export function useTypeSafeTranslations(): TypeSafeTranslations {
  return t
}
