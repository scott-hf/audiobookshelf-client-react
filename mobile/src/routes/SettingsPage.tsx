import { Capacitor } from '@capacitor/core'
import { ChangeEvent } from 'react'
import { useAuth } from '../auth/AuthProvider'
import { useDownloads } from '../downloads/DownloadProvider'
import AbsFileSystemNative from '../native/absFileSystemPlugin'
import { useSettings } from '../settings/SettingsProvider'
import { DownloadDestination, ThemeOption } from '../settings/settingsTypes'

const JUMP_SECONDS_OPTIONS = [5, 10, 15, 30, 45, 60]
const RATE_OPTIONS = [0.75, 1, 1.25, 1.5, 1.75, 2]
const SLEEP_TIMER_OPTIONS: Array<{ label: string; ms: number }> = [
  { label: 'Off', ms: 0 },
  { label: '5 min', ms: 300000 },
  { label: '15 min', ms: 900000 },
  { label: '30 min', ms: 1800000 },
  { label: '60 min', ms: 3600000 }
]

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 MB'
  const mb = bytes / (1024 * 1024)
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`
}

export default function SettingsPage() {
  const { settings, update } = useSettings()
  const { state, logout } = useAuth()
  const { queue } = useDownloads()

  const storageUsageBytes = queue.filter((entry) => entry.state === 'complete').reduce((sum, entry) => sum + entry.bytesDownloaded, 0)

  async function handleDownloadDestinationChange(event: ChangeEvent<HTMLSelectElement>) {
    const destination = event.target.value as DownloadDestination
    if (destination === 'saf' && Capacitor.isNativePlatform()) {
      // Deferred: folder-picker result isn't wired into MobileSettings yet (no persisted
      // folderUri field on this settings shape) -- see docs/mobile-parity.md's SAF row. Calling
      // it here still lets the OS picker run so the choice isn't silently swallowed.
      await AbsFileSystemNative.chooseDownloadFolder()
    }
    update({ downloadDestination: destination })
  }

  function handleExportLogs() {
    // No native log-capture surface exists yet (deferred after v1, see docs/mobile-parity.md) --
    // this is a placeholder that never throws, so the control is present without claiming a
    // capability the app doesn't have.
    window.alert('Log export is not yet available in this build.')
  }

  return (
    <div className="settings-page">
      <h2>Settings</h2>

      <section aria-label="Playback">
        <h3>Playback</h3>
        <label htmlFor="jumpBackSeconds">Jump back</label>
        <select id="jumpBackSeconds" value={settings.jumpBackSeconds} onChange={(event) => update({ jumpBackSeconds: Number(event.target.value) })}>
          {JUMP_SECONDS_OPTIONS.map((seconds) => (
            <option key={seconds} value={seconds}>
              {seconds}s
            </option>
          ))}
        </select>

        <label htmlFor="jumpForwardSeconds">Jump forward</label>
        <select id="jumpForwardSeconds" value={settings.jumpForwardSeconds} onChange={(event) => update({ jumpForwardSeconds: Number(event.target.value) })}>
          {JUMP_SECONDS_OPTIONS.map((seconds) => (
            <option key={seconds} value={seconds}>
              {seconds}s
            </option>
          ))}
        </select>

        <label htmlFor="playbackRate">Default playback rate</label>
        <select id="playbackRate" value={settings.playbackRate} onChange={(event) => update({ playbackRate: Number(event.target.value) })}>
          {RATE_OPTIONS.map((rate) => (
            <option key={rate} value={rate}>
              {rate}x
            </option>
          ))}
        </select>

        <label htmlFor="sleepTimerDefaultMs">Sleep timer default</label>
        <select id="sleepTimerDefaultMs" value={settings.sleepTimerDefaultMs} onChange={(event) => update({ sleepTimerDefaultMs: Number(event.target.value) })}>
          {SLEEP_TIMER_OPTIONS.map((option) => (
            <option key={option.ms} value={option.ms}>
              {option.label}
            </option>
          ))}
        </select>
      </section>

      <section aria-label="Downloads">
        <h3>Downloads</h3>
        <input id="wifiOnly" type="checkbox" checked={settings.wifiOnly} onChange={(event) => update({ wifiOnly: event.target.checked })} />
        <label htmlFor="wifiOnly">Wi-Fi downloads only</label>

        <label htmlFor="downloadDestination">Download destination</label>
        <select id="downloadDestination" value={settings.downloadDestination} onChange={(event) => void handleDownloadDestinationChange(event)}>
          <option value="internal">App storage</option>
          <option value="saf">Choose folder…</option>
        </select>

        <p>
          Local storage used: <strong>{formatBytes(storageUsageBytes)}</strong>
        </p>
      </section>

      <section aria-label="Display">
        <h3>Display</h3>
        <label htmlFor="theme">Theme</label>
        <select id="theme" value={settings.theme} onChange={(event) => update({ theme: event.target.value as ThemeOption })}>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
          <option value="black">Black (OLED)</option>
        </select>
      </section>

      <section aria-label="Connection">
        <h3>Connection</h3>
        <p>Server: {state.status === 'authenticated' ? state.serverUrl : 'Not connected'}</p>
        <button type="button" onClick={() => void logout()}>
          Log out
        </button>
      </section>

      <section aria-label="Diagnostics">
        <h3>Diagnostics</h3>
        <button type="button" onClick={handleExportLogs}>
          Export logs
        </button>
      </section>
    </div>
  )
}
