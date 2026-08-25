import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '../auth/AuthProvider'
import { DownloadProvider } from '../downloads/DownloadProvider'
import SettingsPage from '../routes/SettingsPage'
import type { SettingsStorage } from './settingsTypes'
import { SettingsProvider } from './SettingsProvider'

function fakeStorage(): SettingsStorage {
  return {
    read: vi.fn().mockResolvedValue(null),
    write: vi.fn().mockResolvedValue(undefined)
  }
}

function renderSettings(storage: SettingsStorage) {
  const authValue: AuthContextValue = {
    state: { status: 'authenticated', serverUrl: 'https://books.test' },
    client: {} as AuthContextValue['client'],
    acquisitionClient: null,
    login: vi.fn(),
    logout: vi.fn()
  }
  return render(
    <AuthContext.Provider value={authValue}>
      <DownloadProvider>
        <SettingsProvider storage={storage}>
          <SettingsPage />
        </SettingsProvider>
      </DownloadProvider>
    </AuthContext.Provider>
  )
}

describe('SettingsProvider', () => {
  it('persists player and download policies without storing credentials', async () => {
    const storage = fakeStorage()
    const user = userEvent.setup()
    renderSettings(storage)

    await user.click(screen.getByLabelText('Wi-Fi downloads only'))
    await user.selectOptions(screen.getByLabelText('Jump forward'), '30')

    expect(storage.write).toHaveBeenCalledWith(expect.objectContaining({ wifiOnly: true, jumpForwardSeconds: 30 }))
    expect(JSON.stringify((storage.write as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('accessToken')
  })

  it('never touches the secure session vault', async () => {
    const storage = fakeStorage()
    const user = userEvent.setup()
    renderSettings(storage)

    await user.selectOptions(screen.getByLabelText('Default playback rate'), '1.5')

    const written = (storage.write as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]
    expect(written).not.toHaveProperty('accessToken')
    expect(written).not.toHaveProperty('refreshToken')
    expect(written).not.toHaveProperty('serverUrl')
  })
})
