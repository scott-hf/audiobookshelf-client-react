/**
 * Local device/playback preference types -- WI-1496 t900 Task 5. Deliberately separate from
 * `auth/vault.ts`'s `SessionVault`/`StoredSession`: these are plain UI/playback preferences
 * (never auth material), so unlike the session vault they don't need the AndroidX-Security
 * encrypted store (`native/secureSession.ts`) -- see `SettingsProvider.tsx`'s doc comment for the
 * explicit "never touches the token vault" guarantee this split exists to make checkable.
 */

export type ThemeOption = 'dark' | 'light' | 'black'
export type DownloadDestination = 'internal' | 'saf'

export interface MobileSettings {
  jumpBackSeconds: number
  jumpForwardSeconds: number
  playbackRate: number
  /** Milliseconds, matching the donor app's `sleepTimerLength` unit (`DeviceSettings.swift`/
   * `pages/settings.vue`). */
  sleepTimerDefaultMs: number
  wifiOnly: boolean
  downloadDestination: DownloadDestination
  theme: ThemeOption
}

export const DefaultMobileSettings: MobileSettings = {
  jumpBackSeconds: 10,
  jumpForwardSeconds: 30,
  playbackRate: 1,
  sleepTimerDefaultMs: 900000,
  // NOTE: the Task 5 plan doc's own `DefaultMobileSettings` snippet lists `wifiOnly: true`, but
  // its own `SettingsProvider.test.tsx` snippet (verbatim, same doc) asserts a single click on
  // the "Wi-Fi downloads only" checkbox produces `wifiOnly: true` -- only consistent if the
  // checkbox starts unchecked. Defaulting to `false` here resolves that internal inconsistency
  // in the plan doc's own reference material in the test's favor (a single click toggling
  // false->true is also the more conventional "opt in" UX for a Wi-Fi-only restriction).
  wifiOnly: false,
  downloadDestination: 'internal',
  theme: 'dark'
} as const

export interface SettingsStorage {
  read(): Promise<Partial<MobileSettings> | null>
  write(settings: MobileSettings): Promise<void>
}

const SETTINGS_STORAGE_KEY = 'shelfdroid.settings'

/** Default storage: WebView/browser `localStorage`. Never the secure token vault -- these are
 * plain preferences, not credentials, so encrypted storage is unnecessary overhead here (the
 * inverse gap would be a real security bug, which is what `SettingsProvider.test.tsx` guards
 * against). Read/write failures degrade to "no persistence" rather than throwing, matching
 * `native/secureSession.ts`'s fail-safe pattern for the same class of storage. */
export const localSettingsStorage: SettingsStorage = {
  async read() {
    try {
      const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY)
      return raw ? (JSON.parse(raw) as Partial<MobileSettings>) : null
    } catch {
      return null
    }
  },
  async write(settings) {
    try {
      window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings))
    } catch {
      // Best-effort persistence only -- see read() above.
    }
  }
}
