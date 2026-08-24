import { registerPlugin } from '@capacitor/core'
import type { SessionVault, StoredSession } from '../auth/vault'

interface SecureSessionNativeApi {
  read(): Promise<{ value: string | null }>
  write(options: { value: string }): Promise<void>
  clear(): Promise<void>
}

/** Native bridge to android/app/.../SecureSessionPlugin.kt (AndroidX Security encrypted
 * SharedPreferences). No web implementation is registered -- secureVault below treats any
 * failure (e.g. running the Vite dev preview outside the Capacitor WebView) as "no session"
 * rather than throwing, since the only real target for stored auth tokens is the Android app. */
const SecureSessionNative = registerPlugin<SecureSessionNativeApi>('SecureSession')

export const secureVault: SessionVault = {
  async read(): Promise<StoredSession | null> {
    try {
      const { value } = await SecureSessionNative.read()
      if (!value) return null
      return JSON.parse(value) as StoredSession
    } catch {
      return null
    }
  },
  async write(session: StoredSession): Promise<void> {
    try {
      await SecureSessionNative.write({ value: JSON.stringify(session) })
    } catch {
      // No native implementation outside the Android app (e.g. `vite dev` preview) --
      // tokens simply aren't persisted there, which is the safe failure mode.
    }
  },
  async clear(): Promise<void> {
    try {
      await SecureSessionNative.clear()
    } catch {
      // See write() above.
    }
  }
}

export default SecureSessionNative
