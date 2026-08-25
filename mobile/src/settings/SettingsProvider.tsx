import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react'
import { DefaultMobileSettings, localSettingsStorage, MobileSettings, SettingsStorage } from './settingsTypes'

export interface SettingsContextValue {
  settings: MobileSettings
  update: (patch: Partial<MobileSettings>) => void
}

export const SettingsContext = createContext<SettingsContextValue | undefined>(undefined)

/**
 * Local device/playback preferences provider -- WI-1496 t900 Task 5, mirroring
 * `DownloadProvider`'s "context owns the live state" shape.
 *
 * SECURITY: this provider and its default `storage` (`localSettingsStorage`, plain
 * `localStorage`) never read from or write to `auth/vault.ts`'s `SessionVault` /
 * `native/secureSession.ts`'s encrypted token store -- it only ever sees the `MobileSettings`
 * shape (jump/rate/sleep-timer/Wi-Fi/destination/theme), which has no token/credential field to
 * leak in the first place. `storage` is injectable (defaulting to `localSettingsStorage`) purely
 * so tests can assert on a fake `write` mock without touching real `localStorage`.
 */
export function SettingsProvider({ children, storage = localSettingsStorage }: { children: ReactNode; storage?: SettingsStorage }) {
  const [settings, setSettings] = useState<MobileSettings>(DefaultMobileSettings)

  useEffect(() => {
    let cancelled = false
    void storage.read().then((stored) => {
      if (!cancelled && stored) setSettings((prev) => ({ ...prev, ...stored }))
    })
    return () => {
      cancelled = true
    }
  }, [storage])

  const update = useCallback(
    (patch: Partial<MobileSettings>) => {
      setSettings((prev) => {
        const next = { ...prev, ...patch }
        void storage.write(next)
        return next
      })
    },
    [storage]
  )

  return <SettingsContext.Provider value={{ settings, update }}>{children}</SettingsContext.Provider>
}

export function useSettings(): SettingsContextValue {
  const value = useContext(SettingsContext)
  if (!value) {
    throw new Error('useSettings must be used within a SettingsProvider')
  }
  return value
}
