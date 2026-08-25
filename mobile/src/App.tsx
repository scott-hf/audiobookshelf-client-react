import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './auth/AuthProvider'
import LoadingView from './components/LoadingView'
import { AcquisitionProvider } from './contexts/AcquisitionContext'
import { DownloadProvider } from './downloads/DownloadProvider'
import { PlayerProvider } from './player/PlayerProvider'
import AcquisitionQueuePage from './routes/AcquisitionQueuePage'
import BookDetailsPage from './routes/BookDetailsPage'
import DiscoverPage from './routes/DiscoverPage'
import DownloadsPage from './routes/DownloadsPage'
import LibrariesPage from './routes/LibrariesPage'
import LibraryPage from './routes/LibraryPage'
import LoginPage from './routes/LoginPage'
import PlayerPage from './routes/PlayerPage'

function AuthenticatedApp() {
  return (
    <AcquisitionProvider>
      <DownloadProvider>
        <PlayerProvider>
          <nav className="app-nav">
            <Link to="/downloads">Downloads</Link>
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
            <Route path="*" element={<Navigate to="/libraries" replace />} />
          </Routes>
        </PlayerProvider>
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
