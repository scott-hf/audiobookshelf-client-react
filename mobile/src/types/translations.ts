// Mobile counterpart of the upstream client's src/types/translations.ts.
// Same key typing, but the `rich` overload drops next-intl's RichTagsFunction
// (the mobile app has no next-intl dependency -- see hooks/useTypeSafeTranslations).

import type { ReactNode } from 'react'
import type enUsMessages from '../locales/en-us.json'

type Messages = typeof enUsMessages
type NestedKeyOf<ObjectType extends object> = {
  [Key in keyof ObjectType & (string | number)]: ObjectType[Key] extends object ? `${Key}` | `${Key}.${NestedKeyOf<ObjectType[Key]>}` : `${Key}`
}[keyof ObjectType & (string | number)]

export type TranslationKey = NestedKeyOf<Messages>

export type TranslationValues = Record<string, string | number>

// Type-safe translation function
export interface TypeSafeTranslations {
  (key: TranslationKey): string
  (key: TranslationKey, values: TranslationValues): string
  rich: {
    (key: TranslationKey, values: Record<string, string | number | ReactNode>): ReactNode
  }
}
