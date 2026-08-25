import { FormEvent, useState } from 'react'
import { useAuth } from '../auth/AuthProvider'
import { AbsAuthError, normalizeServerUrl } from '../auth/session'
import Btn from '../components/ui/Btn'
import TextInput from '../components/ui/TextInput'

/**
 * Sign-in failures fall into three very different buckets, and telling them apart matters:
 * a request the browser never sent (bad address, server down, CORS) used to surface the same
 * "check your credentials" text as a real 401, sending people off to re-check credentials that
 * were never wrong.
 *
 * `fetch` rejects with a TypeError for every pre-response failure -- DNS, connection refused,
 * mixed content, and CORS rejections all look identical here by design (the browser withholds
 * the detail), so they share one message that points at reachability rather than credentials.
 */
function describeLoginError(error: unknown): string {
  if (error instanceof TypeError) {
    return 'Could not reach that server. Check the address, that the server is running, and that it allows this app’s origin.'
  }
  if (error instanceof AbsAuthError) {
    if (error.status === 401 || error.status === 403) return 'Incorrect username or password.'
    if (error.status >= 500) return `The server returned an error (${error.status}). Try again shortly.`
    return `The server rejected the sign-in (${error.status}).`
  }
  return 'Could not sign in. Please try again.'
}

export default function LoginPage() {
  const { login } = useAuth()
  const [serverUrl, setServerUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // TextInput does not forward `required`, so the previous native-validation guard is
  // replaced by an explicit disabled-submit check (also better mobile UX than a validation bubble).
  const canSubmit = serverUrl.trim().length > 0 && username.trim().length > 0 && !submitting

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (!canSubmit) return

    // normalizeServerUrl builds a `new URL(...)`, which also throws TypeError on a malformed
    // address -- checked up front so a typo does not get reported as an unreachable server.
    try {
      normalizeServerUrl(serverUrl)
    } catch {
      setError('That does not look like a valid server address.')
      return
    }

    setSubmitting(true)
    setError(null)
    try {
      await login(serverUrl, username, password)
    } catch (err) {
      setError(describeLoginError(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center px-2 py-8">
      <form className="w-full max-w-sm" onSubmit={handleSubmit}>
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <span className="abs-icons icon-audiobookshelf text-accent text-5xl" aria-hidden="true" />
          <h2 className="text-foreground text-xl font-semibold">Connect to Audiobookshelf</h2>
          <p className="text-foreground-subdued text-sm">Sign in to your server to browse and download your library.</p>
        </div>

        <div className="flex flex-col gap-4">
          <TextInput
            id="serverUrl"
            name="serverUrl"
            label="Server address"
            placeholder="books.example.com"
            value={serverUrl}
            onChange={setServerUrl}
            enterKeyHint="next"
            trimWhitespace
          />
          <TextInput id="username" name="username" label="Username" value={username} onChange={setUsername} autocomplete="username" enterKeyHint="next" trimWhitespace />
          <TextInput id="password" name="password" label="Password" type="password" value={password} onChange={setPassword} autocomplete="current-password" enterKeyHint="go" />
        </div>

        {error && (
          <p role="alert" className="text-error mt-4 text-center text-sm">
            {error}
          </p>
        )}

        <Btn type="submit" color="bg-accent" disabled={!canSubmit} loading={submitting} className="mt-6 w-full justify-center">
          Sign in
        </Btn>
      </form>
    </div>
  )
}
