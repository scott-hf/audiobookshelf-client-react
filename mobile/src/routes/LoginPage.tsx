import { FormEvent, useState } from 'react'
import { useAuth } from '../auth/AuthProvider'

export default function LoginPage() {
  const { login } = useAuth()
  const [serverUrl, setServerUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      await login(serverUrl, username, password)
    } catch {
      setError('Could not sign in. Check your server address and credentials.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form className="login-form" onSubmit={handleSubmit}>
      <h2>Connect to Audiobookshelf</h2>
      <label htmlFor="serverUrl">Server address</label>
      <input
        id="serverUrl"
        name="serverUrl"
        type="text"
        autoCapitalize="none"
        autoCorrect="off"
        placeholder="books.example.com"
        value={serverUrl}
        onChange={(event) => setServerUrl(event.target.value)}
        required
      />
      <label htmlFor="username">Username</label>
      <input
        id="username"
        name="username"
        type="text"
        autoCapitalize="none"
        autoCorrect="off"
        value={username}
        onChange={(event) => setUsername(event.target.value)}
        required
      />
      <label htmlFor="password">Password</label>
      <input id="password" name="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
      {error && (
        <p role="alert" className="login-error">
          {error}
        </p>
      )}
      <button type="submit" disabled={submitting}>
        {submitting ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  )
}
