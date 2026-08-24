import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  // Prevent vite from walking up to the root Next.js app's postcss.config.mjs
  // (Tailwind v4 plugin object, incompatible with vite's default postcss loader).
  css: { postcss: { plugins: [] } },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // e2e/ holds Playwright specs (playwright.config.ts, its own runner/assertions) -- vitest's
    // default include glob would otherwise also pick up *.spec.ts there and fail immediately
    // (no jsdom `page`, wrong `test`/`expect` globals).
    exclude: ['**/node_modules/**', 'e2e/**']
  }
})
