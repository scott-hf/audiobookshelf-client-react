import { Capacitor } from '@capacitor/core'
import { ChangeEvent, ReactNode } from 'react'
import { useAuth } from '../auth/AuthProvider'
import SelectField from '../components/SelectField'
import Btn from '../components/ui/Btn'
import ToggleSwitch from '../components/ui/ToggleSwitch'
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

function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="mb-5">
      <h3 className="text-foreground-muted mb-1 text-xs font-semibold tracking-widest uppercase">{title}</h3>
      <div className="bg-primary border-border divide-border divide-y rounded-md border px-3">{children}</div>
    </section>
  )
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
    <div>
      <h2 className="text-foreground mb-3 text-lg font-semibold">Settings</h2>

      <SettingsSection title="Playback">
        <SelectField id="jumpBackSeconds" label="Jump back" value={settings.jumpBackSeconds} onChange={(event) => update({ jumpBackSeconds: Number(event.target.value) })}>
          {JUMP_SECONDS_OPTIONS.map((seconds) => (
            <option key={seconds} value={seconds}>
              {seconds}s
            </option>
          ))}
        </SelectField>

        <SelectField
          id="jumpForwardSeconds"
          label="Jump forward"
          value={settings.jumpForwardSeconds}
          onChange={(event) => update({ jumpForwardSeconds: Number(event.target.value) })}
        >
          {JUMP_SECONDS_OPTIONS.map((seconds) => (
            <option key={seconds} value={seconds}>
              {seconds}s
            </option>
          ))}
        </SelectField>

        <SelectField id="playbackRate" label="Default playback rate" value={settings.playbackRate} onChange={(event) => update({ playbackRate: Number(event.target.value) })}>
          {RATE_OPTIONS.map((rate) => (
            <option key={rate} value={rate}>
              {rate}x
            </option>
          ))}
        </SelectField>

        <SelectField
          id="sleepTimerDefaultMs"
          label="Sleep timer default"
          value={settings.sleepTimerDefaultMs}
          onChange={(event) => update({ sleepTimerDefaultMs: Number(event.target.value) })}
        >
          {SLEEP_TIMER_OPTIONS.map((option) => (
            <option key={option.ms} value={option.ms}>
              {option.label}
            </option>
          ))}
        </SelectField>
      </SettingsSection>

      <SettingsSection title="Downloads">
        <div className="py-1">
          <ToggleSwitch label="Wi-Fi downloads only" value={settings.wifiOnly} onChange={(value) => update({ wifiOnly: value })} />
        </div>

        <SelectField
          id="downloadDestination"
          label="Download destination"
          value={settings.downloadDestination}
          onChange={(event) => void handleDownloadDestinationChange(event)}
        >
          <option value="internal">App storage</option>
          <option value="saf">Choose folder…</option>
        </SelectField>

        <p className="text-foreground-subdued flex items-center justify-between py-3 text-sm">
          Local storage used
          <strong className="text-foreground tabular-nums">{formatBytes(storageUsageBytes)}</strong>
        </p>
      </SettingsSection>

      <SettingsSection title="Display">
        <SelectField id="theme" label="Theme" value={settings.theme} onChange={(event) => update({ theme: event.target.value as ThemeOption })}>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
          <option value="black">Black (OLED)</option>
        </SelectField>
      </SettingsSection>

      <SettingsSection title="Connection">
        <p className="text-foreground-subdued flex items-center justify-between gap-3 py-3 text-sm">
          Server
          <span className="text-foreground min-w-0 truncate">{state.status === 'authenticated' ? state.serverUrl : 'Not connected'}</span>
        </p>
        <div className="py-3">
          <Btn size="small" color="bg-error" onClick={() => void logout()} className="w-full justify-center">
            Log out
          </Btn>
        </div>
      </SettingsSection>

      <SettingsSection title="Diagnostics">
        <div className="py-3">
          <Btn size="small" onClick={handleExportLogs} className="w-full justify-center">
            Export logs
          </Btn>
        </div>
      </SettingsSection>
    </div>
  )
}
