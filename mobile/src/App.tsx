import { BrowserRouter } from 'react-router-dom'

export default function App() {
  return (
    <BrowserRouter>
      <div className="app-shell">
        <header className="app-topbar">
          <h1>ShelfDroid</h1>
        </header>
        <main className="app-content">
          <p>Connect to your Audiobookshelf server to get started.</p>
        </main>
      </div>
    </BrowserRouter>
  )
}
