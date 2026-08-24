import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './auth/AuthProvider'
import LoadingView from './components/LoadingView'
import BookDetailsPage from './routes/BookDetailsPage'
import LibrariesPage from './routes/LibrariesPage'
import LibraryPage from './routes/LibraryPage'
import LoginPage from './routes/LoginPage'

function AuthenticatedApp() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/libraries" replace />} />
      <Route path="/libraries" element={<LibrariesPage />} />
      <Route path="/library/:libraryId" element={<LibraryPage />} />
      <Route path="/library/:libraryId/item/:itemId" element={<BookDetailsPage />} />
      <Route path="*" element={<Navigate to="/libraries" replace />} />
    </Routes>
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
