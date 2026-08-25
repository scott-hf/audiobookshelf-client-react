import { App as CapacitorApp } from '@capacitor/app'
import { useEffect, useRef } from 'react'
import { BrowserRouter, Link, Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './auth/AuthProvider'
import LoadingView from './components/LoadingView'
import { AcquisitionProvider } from './contexts/AcquisitionContext'
import { DownloadProvider } from './downloads/DownloadProvider'
import { routeFromDeepLink } from './navigation/deepLinks'
import { PlayerProvider } from './player/PlayerProvider'
import { SettingsProvider } from './settings/SettingsProvider'
import AcquisitionQueuePage from './routes/AcquisitionQueuePage'
import BookDetailsPage from './routes/BookDetailsPage'
import DiscoverPage from './routes/DiscoverPage'
import DownloadsPage from './routes/DownloadsPage'
import LibrariesPage from './routes/LibrariesPage'
import LibraryPage from './routes/LibraryPage'
import LoginPage from './routes/LoginPage'
import PlayerPage from './routes/PlayerPage'
import SettingsPage from './routes/SettingsPage'

/** Handles `appUrlOpen` deep links (verified HTTPS App Links + the `shelfdroid://` custom
 * scheme -- WI-1496 t900 Task 4). Rendered unconditionally inside AuthProvider/BrowserRouter so
 * it can catch a link that arrives before the session is restored: an unauthenticated open is
 * queued in a ref (not state -- it must not trigger a route change of its own) and replayed once
 * `state.status` flips to `authenticated`, reusing the same auth-state signal AppBody already
 * gates on rather than inventing a second one. */
function DeepLinkListener() {
  const { state } = useAuth()
  const navigate = useNavigate()
  const pendingRouteRef = useRef<string | null>(null)
  const statusRef = useRef(state.status)
  statusRef.current = state.status

  useEffect(() => {
    const listenerHandle = CapacitorApp.addListener('appUrlOpen', ({ url }) => {
      const route = routeFromDeepLink(url)
      if (!route) return
      if (statusRef.current === 'authenticated') {
        navigate(route)
      } else {
        pendingRouteRef.current = route
      }
    })
    return () => {
      void listenerHandle.then((handle) => handle.remove())
    }
  }, [navigate])

  useEffect(() => {
    if (state.status === 'authenticated' && pendingRouteRef.current) {
      navigate(pendingRouteRef.current)
      pendingRouteRef.current = null
    }
  }, [state.status, navigate])

  return null
}

function AuthenticatedApp() {
  return (
    <AcquisitionProvider>
      <DownloadProvider>
        <SettingsProvider>
          <PlayerProvider>
            <nav className="app-nav">
              <Link to="/downloads">Downloads</Link>
              {/* WI-1496 t900 Task 5 follow-up: SettingsPage/SettingsProvider existed but were
                  never reachable from the app shell -- wired here so the settings feature the
                  parity audit documents as "implemented" is actually navigable. */}
              <Link to="/settings">Settings</Link>
            </nav>
            <Routes>
              <Route path="/" element={<Navigate to="/libraries" replace />} />
              <Route path="/libraries" element={<LibrariesPage />} />
              <Route path="/library/:libraryId" element={<LibraryPage />} />
              <Route path="/library/:libraryId/discover" element={<DiscoverPage />} />
              <Route path="/library/:libraryId/acquisition-queue" element={<AcquisitionQueuePage />} />
              <Route path="/library/:libraryId/item/:itemId" element={<BookDetailsPage />} />
              <Route path="/library/:libraryId/item/:itemId/play" element={<PlayerPage />} />
              <Route path="/downloads" element={<DownloadsPage />} />
              {/* WI-1496 t800 Task 5: the offline catalog only has a `libraryItemId`, no
                  `libraryId` -- PlayerPage only ever reads `:itemId` (see routes/PlayerPage.tsx),
                  so this route reuses the same component under a libraryId-free path. */}
              <Route path="/downloads/:itemId/play" element={<PlayerPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="*" element={<Navigate to="/libraries" replace />} />
            </Routes>
          </PlayerProvider>
        </SettingsProvider>
      </DownloadProvider>
    </AcquisitionProvider>
  )
}

function AppBody() {
  const { state } = useAuth()
  if (state.status === 'unknown') return <LoadingView label="Starting ShelfDroid…" />
  if (state.status === 'unauthenticated') return <LoginPage />
  return <AuthenticatedApp />
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <DeepLinkListener />
        <div className="app-shell">
          <header className="app-topbar">
            <h1>ShelfDroid</h1>
          </header>
          <main className="app-content">
            <AppBody />
          </main>
        </div>
      </AuthProvider>
    </BrowserRouter>
  )
}
