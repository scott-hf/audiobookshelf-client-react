import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import capacitorConfig from '../capacitor.config'
import App from './App'

describe('App', () => {
  it('renders the local mobile shell without a remote server URL', () => {
    render(<App />)
    expect(screen.getByRole('heading', { name: 'ShelfDroid' })).toBeInTheDocument()
    expect(capacitorConfig.server?.url).toBeUndefined()
    expect(capacitorConfig.webDir).toBe('dist')
  })
})
